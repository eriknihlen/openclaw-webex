/**
 * Webex-specific formatting helpers.
 *
 * Webex renders its own subset of CommonMark (no tables, no task lists,
 * limited HTML) and caps every message at 7439 bytes. This module owns
 * the rules so the rest of the plugin can emit structured output without
 * knowing the platform's quirks.
 *
 */
/**
 * Maximum bytes Webex accepts for text/markdown on POST /messages. We
 * leave a small safety margin when chunking to absorb Unicode expansion
 * around the boundary we pick.
 */
export declare const WEBEX_TEXT_LIMIT_BYTES = 7439;
export declare const WEBEX_SAFE_CHUNK_BYTES = 7200;
/**
 * Escape markdown control characters in user-supplied content before
 * interpolating it into a markdown template (e.g. backticks around a
 * file path, asterisks inside a bold verb).
 *
 * Intentionally conservative — we escape the characters Webex's renderer
 * actually treats as syntax. Angle brackets / plain HTML are left alone
 * because Webex strips unsupported tags anyway and escaping them would
 * harm readability of things like `<hostname>`.
 */
export declare function escapeMarkdown(s: string): string;
/**
 * Produce a Webex markdown @mention targeting a personId. Displayed name
 * is optional — if provided it's used as the link text; otherwise Webex
 * renders the person's own display name.
 *
 * Standard `@user` syntax is NOT rendered by Webex — the `<@personId:...>`
 * form is the only one that creates a notification.
 */
export declare function mentionMarkdown(personId: string, displayName?: string): string;
/**
 * Split a text payload into chunks that each fit inside Webex's
 * 7439-byte limit. Prefers paragraph boundaries (`\n\n`); falls back
 * to sentence boundaries, then word boundaries, then hard character
 * cuts for pathologically long tokens.
 *
 * Does NOT understand code fences or markdown structure — a fenced
 * block that crosses a chunk boundary will render with a stray ```
 * on one side. Tier 2 adds fence-aware splitting.
 */
export declare function splitForWebex(text: string, limit?: number): string[];
/**
 * Strip markdown syntax characters from a free-form string — used on
 * the reasoning-stream tail before it's interpolated into a Webex
 * `*italic*` context. Prevents unbalanced backticks or stray asterisks
 * from breaking the renderer mid-stream.
 *
 * We also collapse runs of whitespace so the tail reads as one line.
 */
export declare function stripMarkdownSyntax(s: string): string;
/**
 * Convert markdown pipe-tables to fenced code blocks with aligned
 * columns. Webex's markdown renderer does not understand `|`-table
 * syntax — it renders the literal pipes, which looks terrible. A
 * plain-text aligned block in a monospace code fence is readable
 * and preserves the tabular structure.
 *
 * Detection rule: a run of two-or-more consecutive lines where every
 * line starts and ends with `|`, and the second line is a separator
 * (cells containing only `-` and optional `:`).
 *
 * Non-table content passes through unchanged.
 */
export declare function transformMarkdownForWebex(md: string): string;
/**
 * Walk backward through a markdown tail so the final character doesn't
 * leave a dangling fence / backtick / asterisk. Used when we truncate
 * to a byte/char window and the cut lands mid-construct.
 *
 * Returns the tail trimmed to a safe boundary — in the worst case
 * (everything is unbalanced) it returns the empty string.
 */
export declare function trimToSafeMarkdownBoundary(s: string): string;
/**
 * Best-effort detection of whether a string is "markdown-looking" (has
 * tokens the plugin should honour by setting the `markdown` field on
 * POST /messages even if the agent didn't explicitly set it).
 *
 * We treat backticks, **bold**, _emphasis_, # headings, -/* lists,
 * fenced code blocks, and Markdown link syntax as positive signals.
 * False positives are harmless (the text field still carries the same
 * string for fallback clients).
 */
export declare function looksMarkdown(s: string): boolean;
