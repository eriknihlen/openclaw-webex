"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProgressReporter = createProgressReporter;
const DEFAULT_INITIAL_DEBOUNCE_MS = 800;
const DEFAULT_EDITABLE_LIMIT = 8;
function createProgressReporter(opts) {
    const { sender, to, parentId, onWarn } = opts;
    const initialDebounceMs = opts.initialDebounceMs ?? DEFAULT_INITIAL_DEBOUNCE_MS;
    const editableLimit = opts.editableLimit ?? DEFAULT_EDITABLE_LIMIT;
    const startedAt = Date.now();
    let lastPostedText;
    let pendingText;
    let pendingMarkdown;
    let flushing = false;
    let closed = false;
    let hasPosted = false;
    let debounceTimer;
    let debouncePending = false;
    // Edit-in-place state: once we POST the first line, we have a
    // messageId we can PUT to. editableCount tracks how many edits we've
    // performed; when it reaches editableLimit we flip to append mode.
    let firstMessageId;
    let editableCount = 0;
    // Tracks the currently in-flight flush() call (if any) so
    // claimForReply() can chain a cleanup onto it: if a claim attempt
    // lands while the very first POST is still in flight, firstMessageId
    // isn't set yet at claim time, but it may become set moments later
    // when that POST resolves. Without this, that message would post
    // after the hand-off and never get cleaned up.
    let inFlightFlush;
    const warn = (err) => {
        try {
            onWarn?.(err);
        }
        catch {
            // best-effort
        }
    };
    const flush = async () => {
        if (closed || flushing)
            return;
        if (!pendingText || pendingText === lastPostedText)
            return;
        flushing = true;
        const text = pendingText;
        const markdown = pendingMarkdown ?? pendingText;
        pendingText = undefined;
        pendingMarkdown = undefined;
        // Decide edit-in-place vs append for this flush.
        const canEdit = editableLimit > 0 &&
            firstMessageId !== undefined &&
            editableCount < editableLimit;
        try {
            if (canEdit && firstMessageId) {
                await sender.updateMessage(firstMessageId, to, text, markdown);
                editableCount++;
            }
            else {
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
        }
        catch (err) {
            warn(err);
            // If an edit fails (message deleted, edit cap hit, rate limit),
            // fall through to append on the next update.
            if (canEdit) {
                editableCount = editableLimit;
            }
        }
        finally {
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
        update(text, markdown) {
            if (closed)
                return;
            if (!text)
                return;
            pendingText = text;
            pendingMarkdown = markdown;
            // First post is held for the debounce window so sub-second
            // replies never produce a redundant "Working on it…" line.
            if (!hasPosted && !flushing) {
                if (debouncePending)
                    return;
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
            if (closed)
                return undefined;
            closed = true;
            clearDebounce();
            const canClaim = editableLimit > 0 &&
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
                }).catch(() => { });
            }
            else if (firstMessageId) {
                void sender.deleteMessage(firstMessageId).catch((err) => warn(err));
            }
            return undefined;
        },
    };
}
//# sourceMappingURL=progress.js.map