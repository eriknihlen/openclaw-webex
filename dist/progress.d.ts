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
export declare function createProgressReporter(opts: ProgressReporterOptions): ProgressReporter;
