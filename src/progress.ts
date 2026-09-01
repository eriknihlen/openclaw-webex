/**
 * Hybrid progress reporter for Webex: edit-in-place for the first N
 * state transitions, then append.
 *
 *extended the 2026-04-23 append-only reporter
 * with PUT /messages/{id} edits on the initial "Working on it…" line,
 * so short replies read as a single self-updating status row instead
 * of four scattered progress posts. Webex caps edits at 10 per message
 * so we flip to append after the configured editableLimit (default 8
 * — two-edit safety margin).
 *
 * - At most one in-flight API call at a time (serialised via an
 *   internal promise chain). The send.ts rate limiter still enforces
 *   a minimum inter-request interval on top of this.
 * - Deduplication: if update() is called with the same text as the
 *   previous post (e.g. identical rapid events), it is skipped.
 * - Initial debounce: the first post can be held for `initialDebounceMs`.
 *   If close() fires before the debounce elapses, nothing is posted —
 *   useful for avoiding a "Working on it…" flicker on sub-second replies.
 * - Edit-in-place: once the first POST returns a messageId, up to
 *   editableLimit subsequent updates are PUT /messages/{id} refreshes
 *   on that same message. After the limit, we switch to append so the
 *   Webex edit cap can't be hit.
 * - close() stops accepting updates. It does NOT delete any messages —
 *   any leftover placeholder is the caller's problem (see
 *   claimForReply() below, which the reply path uses instead of close()
 *   to repurpose or clean up the placeholder rather than abandon it).
 * - claimForReply(): the reply-delivery path uses this instead of
 *   close() when it wants to turn the placeholder into the final answer
 *   (edit-in-place) rather than post a separate message. See its own
 *   doc comment for the contract.
 */

import type { WebexSender } from "./send";

export interface ProgressReporterOptions {
  sender: WebexSender;
  /** Room or person id to post into */
  to: string;
  /** Optional thread parent for posted messages */
  parentId?: string;
  /** Non-fatal warning hook */
  onWarn?: (err: unknown) => void;
  /**
   * Delay before the first post is made. If close() is called before
   * this elapses, nothing posts at all. Default 800ms. Set to 0 to post
   * the first update immediately.
   */
  initialDebounceMs?: number;
  /**
   * Maximum number of PUT /messages/{id} edits to perform on the
   * initial progress message before switching to append. Webex caps
   * edits at 10 per message — we default to 8 to leave a safety
   * margin. Set to 0 to disable edit-in-place entirely.
   */
  editableLimit?: number;
}

export interface ProgressReporter {
  /**
   * Wall-clock time (Date.now()) this reporter was created. Callers
   * that want a "· 2m" elapsed suffix on a progress line (without
   * spending an extra edit to add one) compute it off this rather than
   * tracking their own turn-start timestamp.
   */
  readonly startedAt: number;
  /**
   * Post a progress line. Duplicates (same as previous) are skipped.
   *
   * `text` is the plain-text fallback shown on clients that don't render
   * markdown. `markdown` is optional and overrides the rendered content
   * on modern clients; when omitted, `text` is also sent in the markdown
   * field so plain-text strings still flow through correctly.
   */
  update(text: string, markdown?: string): void;
  /** Stop accepting further updates. Does not delete anything. */
  close(): Promise<void>;
  /**
   * Hand off the placeholder message to the reply path so it can be
   * turned into the final answer instead of leaving it behind. Returns
   * the placeholder's messageId ONLY when reuse is actually safe:
   *   (a) a message has actually been posted (a messageId exists), and
   *   (b) at least one more PUT edit is still safe under the Webex
   *       10-edit cap — i.e. the reporter hasn't already spent its
   *       edits and flipped to append mode (same editableCount <
   *       editableLimit check `flush()` itself uses).
   * Returns undefined otherwise — including when no message was ever
   * posted at all (a fast turn that never got past the initial
   * debounce, or progress reporting disabled).
   *
   * Calling this ALWAYS closes the reporter, whether or not it returns
   * an id: no further update()/flush() may touch the placeholder after
   * a claim attempt, successful or not, so the reply path can safely
   * take over (or clean up) without the reporter fighting it. When the
   * placeholder exists but isn't claimable (overflowed to append mode,
   * or a post is still in flight and lands after the call), this makes
   * a best-effort attempt to delete it itself so it doesn't linger next
   * to the fresh reply — callers don't need to do that cleanup for the
   * "claim failed but a message exists" case themselves.
   */
  claimForReply(): string | undefined;
}

const DEFAULT_INITIAL_DEBOUNCE_MS = 800;
const DEFAULT_EDITABLE_LIMIT = 8;

export function createProgressReporter(
  opts: ProgressReporterOptions
): ProgressReporter {
  const { sender, to, parentId, onWarn } = opts;
  const initialDebounceMs =
    opts.initialDebounceMs ?? DEFAULT_INITIAL_DEBOUNCE_MS;
  const editableLimit = opts.editableLimit ?? DEFAULT_EDITABLE_LIMIT;
  const startedAt = Date.now();

  let lastPostedText: string | undefined;
  let pendingText: string | undefined;
  let pendingMarkdown: string | undefined;
  let flushing = false;
  let closed = false;
  let hasPosted = false;
  let debounceTimer: NodeJS.Timeout | undefined;
  let debouncePending = false;
  // Edit-in-place state: once we POST the first line, we have a
  // messageId we can PUT to. editableCount tracks how many edits we've
  // performed; when it reaches editableLimit we flip to append mode.
  let firstMessageId: string | undefined;
  let editableCount = 0;
  // Tracks the currently in-flight flush() call (if any) so
  // claimForReply() can chain a cleanup onto it: if a claim attempt
  // lands while the very first POST is still in flight, firstMessageId
  // isn't set yet at claim time, but it may become set moments later
  // when that POST resolves. Without this, that message would post
  // after the hand-off and never get cleaned up.
  let inFlightFlush: Promise<void> | undefined;

  const warn = (err: unknown) => {
    try {
      onWarn?.(err);
    } catch {
      // best-effort
    }
  };

  const flush = async (): Promise<void> => {
    if (closed || flushing) return;
    if (!pendingText || pendingText === lastPostedText) return;

    flushing = true;
    const text = pendingText;
    const markdown = pendingMarkdown ?? pendingText;
    pendingText = undefined;
    pendingMarkdown = undefined;

    // Decide edit-in-place vs append for this flush.
    const canEdit =
      editableLimit > 0 &&
      firstMessageId !== undefined &&
      editableCount < editableLimit;

    try {
      if (canEdit && firstMessageId) {
        await sender.updateMessage(firstMessageId, to, text, markdown);
        editableCount++;
      } else {
        const sent = await sender.send({
          to,
          content: { text, markdown },
          parentId,
        });
        if (!firstMessageId && sent?.id) {
          firstMessageId = sent.id;
        }
      }
      lastPostedText = text;
      hasPosted = true;
    } catch (err) {
      warn(err);
      // If an edit fails (message deleted, edit cap hit, rate limit),
      // fall through to append on the next update.
      if (canEdit) {
        editableCount = editableLimit;
      }
    } finally {
      flushing = false;
      // Drain any update that arrived during the in-flight send.
      if (!closed && pendingText && pendingText !== lastPostedText) {
        triggerFlush();
      }
    }
  };

  // All call sites that kick off a flush go through this so
  // inFlightFlush always reflects the most recent one, for
  // claimForReply()'s race-closing chain above.
  const triggerFlush = () => {
    inFlightFlush = flush();
  };

  const clearDebounce = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    debouncePending = false;
  };

  return {
    startedAt,
    update(text: string, markdown?: string) {
      if (closed) return;
      if (!text) return;
      pendingText = text;
      pendingMarkdown = markdown;

      // First post is held for the debounce window so sub-second
      // replies never produce a redundant "Working on it…" line.
      if (!hasPosted && !flushing) {
        if (debouncePending) return;
        debouncePending = true;
        debounceTimer = setTimeout(() => {
          debouncePending = false;
          debounceTimer = undefined;
          triggerFlush();
        }, initialDebounceMs);
        return;
      }

      triggerFlush();
    },

    async close() {
      closed = true;
      clearDebounce();
      while (flushing) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Deliberately no deleteMessage calls here — a plain close() (no
      // reply to hand the placeholder off to, e.g. an error path) leaves
      // progress history in the conversation as a trail of what
      // happened. The reply path uses claimForReply() instead, which
      // does take responsibility for repurposing or deleting the
      // placeholder — see its doc comment.
    },

    claimForReply() {
      if (closed) return undefined;
      closed = true;
      clearDebounce();

      const canClaim =
        editableLimit > 0 &&
        firstMessageId !== undefined &&
        editableCount < editableLimit;
      if (canClaim) {
        return firstMessageId;
      }

      // Not claimable right now. Two cases:
      //  - A placeholder exists but is stuck in append mode (spent its
      //    edits) — it's stale, best-effort delete it now.
      //  - Nothing has posted yet. If a flush is currently in flight
      //    (the first POST is on the wire), it may still land a
      //    messageId moments after we return here with undefined —
      //    chain onto it so that late-arriving placeholder gets cleaned
      //    up too, instead of lingering next to the fresh reply.
      if (flushing && inFlightFlush) {
        void inFlightFlush.then(() => {
          if (firstMessageId) {
            sender.deleteMessage(firstMessageId).catch((err) => warn(err));
          }
        }).catch(() => {});
      } else if (firstMessageId) {
        void sender.deleteMessage(firstMessageId).catch((err) => warn(err));
      }
      return undefined;
    },
  };
}
