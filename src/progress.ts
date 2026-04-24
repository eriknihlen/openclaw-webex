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
 * - close() stops accepting updates. It does NOT delete any messages.
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
        void flush();
      }
    }
  };

  const clearDebounce = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    debouncePending = false;
  };

  return {
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
          void flush();
        }, initialDebounceMs);
        return;
      }

      void flush();
    },

    async close() {
      closed = true;
      clearDebounce();
      while (flushing) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Deliberately no deleteMessage calls — progress history stays
      // in the conversation as a permanent trail of what happened.
    },
  };
}
