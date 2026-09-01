"use strict";
/**
 * Webex-specific formatting helpers.
 *
 * Webex renders its own subset of CommonMark (no tables, no task lists,
 * limited HTML) and caps every message at 7439 bytes. This module owns
 * the rules so the rest of the plugin can emit structured output without
 * knowing the platform's quirks.
 *
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEBEX_SAFE_CHUNK_BYTES = exports.WEBEX_TEXT_LIMIT_BYTES = void 0;
exports.escapeMarkdown = escapeMarkdown;
exports.mentionMarkdown = mentionMarkdown;
exports.splitForWebex = splitForWebex;
exports.stripMarkdownSyntax = stripMarkdownSyntax;
exports.transformMarkdownForWebex = transformMarkdownForWebex;
exports.trimToSafeMarkdownBoundary = trimToSafeMarkdownBoundary;
exports.formatElapsed = formatElapsed;
exports.formatElapsedShort = formatElapsedShort;
exports.looksMarkdown = looksMarkdown;
/**
 * Maximum bytes Webex accepts for text/markdown on POST /messages. We
 * leave a small safety margin when chunking to absorb Unicode expansion
 * around the boundary we pick.
 */
exports.WEBEX_TEXT_LIMIT_BYTES = 7439;
exports.WEBEX_SAFE_CHUNK_BYTES = 7200;
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
function escapeMarkdown(s) {
    if (!s)
        return s;
    return s.replace(/([\\`*_~[\]()])/g, "\\$1");
}
/**
 * Produce a Webex markdown @mention targeting a personId. Displayed name
 * is optional — if provided it's used as the link text; otherwise Webex
 * renders the person's own display name.
 *
 * Standard `@user` syntax is NOT rendered by Webex — the `<@personId:...>`
 * form is the only one that creates a notification.
 */
function mentionMarkdown(personId, displayName) {
    const label = displayName ? `|${displayName}` : "";
    return `<@personId:${personId}${label}>`;
}
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
function splitForWebex(text, limit = exports.WEBEX_SAFE_CHUNK_BYTES) {
    if (!text)
        return [""];
    if (Buffer.byteLength(text, "utf8") <= limit)
        return [text];
    const paragraphs = text.split(/\n{2,}/);
    const chunks = [];
    let current = "";
    const pushCurrent = () => {
        if (current.length > 0) {
            chunks.push(current);
            current = "";
        }
    };
    const appendToCurrent = (piece, sep) => {
        const candidate = current.length === 0 ? piece : current + sep + piece;
        if (Buffer.byteLength(candidate, "utf8") <= limit) {
            current = candidate;
            return true;
        }
        return false;
    };
    for (const paragraph of paragraphs) {
        if (appendToCurrent(paragraph, "\n\n"))
            continue;
        pushCurrent();
        if (Buffer.byteLength(paragraph, "utf8") <= limit) {
            current = paragraph;
            continue;
        }
        // Paragraph alone exceeds the limit — split by sentences, then words.
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
            if (appendToCurrent(sentence, " "))
                continue;
            pushCurrent();
            if (Buffer.byteLength(sentence, "utf8") <= limit) {
                current = sentence;
                continue;
            }
            // Sentence is too long even on its own — split by words.
            const words = sentence.split(/\s+/);
            for (const word of words) {
                if (appendToCurrent(word, " "))
                    continue;
                pushCurrent();
                if (Buffer.byteLength(word, "utf8") <= limit) {
                    current = word;
                    continue;
                }
                // Single token exceeds the limit. Hard-slice it.
                const hardChunks = hardSlice(word, limit);
                for (let i = 0; i < hardChunks.length - 1; i++) {
                    chunks.push(hardChunks[i]);
                }
                current = hardChunks[hardChunks.length - 1];
            }
        }
    }
    pushCurrent();
    return chunks.length > 0 ? chunks : [""];
}
/**
 * Split a single long string into byte-bounded pieces. UTF-8 aware —
 * advances by code unit but re-measures bytes so we never split in the
 * middle of a multi-byte character.
 */
function hardSlice(s, limit) {
    const out = [];
    let start = 0;
    while (start < s.length) {
        let end = Math.min(s.length, start + limit);
        while (end > start && Buffer.byteLength(s.slice(start, end), "utf8") > limit) {
            end--;
        }
        if (end <= start) {
            // Pathological case — a single code unit exceeds the limit.
            end = start + 1;
        }
        out.push(s.slice(start, end));
        start = end;
    }
    return out;
}
/**
 * Strip markdown syntax characters from a free-form string — used on
 * the reasoning-stream tail before it's interpolated into a Webex
 * `*italic*` context. Prevents unbalanced backticks or stray asterisks
 * from breaking the renderer mid-stream.
 *
 * We also collapse runs of whitespace so the tail reads as one line.
 */
function stripMarkdownSyntax(s) {
    if (!s)
        return s;
    return s
        .replace(/[`*_~[\]()]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
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
function transformMarkdownForWebex(md) {
    if (!md || md.indexOf("|") === -1)
        return md;
    const lines = md.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const startIdx = i;
        const rows = [];
        let isTable = false;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
            const row = lines[i]
                .trim()
                .replace(/^\||\|$/g, "")
                .split("|")
                .map((c) => c.trim());
            rows.push(row);
            i++;
        }
        if (rows.length >= 2 &&
            rows[1].every((c) => /^:?-+:?$/.test(c))) {
            isTable = true;
        }
        if (!isTable) {
            // Not actually a table — preserve original lines.
            for (let j = startIdx; j < i; j++) {
                out.push(lines[j]);
            }
            if (i === startIdx) {
                out.push(lines[i]);
                i++;
            }
            continue;
        }
        // Drop the separator row, render the rest as aligned columns.
        const header = rows[0];
        const body = rows.slice(2);
        const dataRows = [header, ...body];
        const colWidths = [];
        for (const row of dataRows) {
            for (let c = 0; c < row.length; c++) {
                const len = [...row[c]].length;
                if (colWidths[c] === undefined || len > colWidths[c]) {
                    colWidths[c] = len;
                }
            }
        }
        out.push("```");
        for (let r = 0; r < dataRows.length; r++) {
            const row = dataRows[r];
            const padded = row.map((cell, c) => cell.padEnd(colWidths[c] ?? 0));
            out.push(padded.join("  ").trimEnd());
            if (r === 0) {
                out.push(colWidths.map((w) => "-".repeat(w)).join("  "));
            }
        }
        out.push("```");
    }
    return out.join("\n");
}
/**
 * Walk backward through a markdown tail so the final character doesn't
 * leave a dangling fence / backtick / asterisk. Used when we truncate
 * to a byte/char window and the cut lands mid-construct.
 *
 * Returns the tail trimmed to a safe boundary — in the worst case
 * (everything is unbalanced) it returns the empty string.
 */
function trimToSafeMarkdownBoundary(s) {
    if (!s)
        return s;
    let out = s;
    // If we have an odd number of fenced code markers (```), drop the
    // last opened fence and anything after it.
    const fenceCount = (out.match(/```/g) ?? []).length;
    if (fenceCount % 2 === 1) {
        const last = out.lastIndexOf("```");
        out = out.slice(0, last).trimEnd();
    }
    // If the remainder has an odd number of single backticks, drop the
    // trailing one so we don't leave inline-code open.
    const tickCount = (out.match(/`/g) ?? []).length;
    if (tickCount % 2 === 1) {
        const last = out.lastIndexOf("`");
        out = out.slice(0, last).trimEnd();
    }
    return out;
}
/**
 * Break an elapsed-ms duration into whole minutes/seconds. Shared by
 * formatElapsed (final-answer "Worked for …" summary) and
 * formatElapsedShort (live progress-line suffix) so the two stay
 * consistent instead of each re-deriving minutes/seconds independently.
 */
function splitElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}
/**
 * Human-readable elapsed time for the final-answer "⏱ Worked for …"
 * summary. Returns undefined for anything under 10s — fast replies
 * don't need a timer stamp. Under a minute: "42s". A minute or more:
 * "3m" (whole minutes) or "3m 15s" when there's a leftover remainder.
 */
function formatElapsed(ms) {
    if (ms < 10_000)
        return undefined;
    const { minutes, seconds } = splitElapsed(ms);
    if (ms < 60_000)
        return `${seconds}s`;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
/**
 * Compact elapsed-time suffix for live progress lines (e.g.
 * "Running `git status` · 2m"). Unlike formatElapsed, this shows
 * sub-10s durations too — a ticking progress line is useful even in
 * the first few seconds — and drops the leftover-seconds remainder
 * once we're into minutes, to keep the suffix short.
 */
function formatElapsedShort(ms) {
    const { minutes, seconds } = splitElapsed(ms);
    if (ms < 60_000)
        return `${seconds}s`;
    return `${minutes}m`;
}
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
function looksMarkdown(s) {
    if (!s)
        return false;
    return (/`[^`]+`/.test(s) ||
        /\*\*[^*]+\*\*/.test(s) ||
        /(^|\s)[*_][^*_\n]+[*_](\s|$)/m.test(s) ||
        /^#{1,6}\s/m.test(s) ||
        /^(-|\*|\d+\.)\s/m.test(s) ||
        /```/.test(s) ||
        /\[[^\]]+\]\([^)]+\)/.test(s));
}
//# sourceMappingURL=formatters.js.map