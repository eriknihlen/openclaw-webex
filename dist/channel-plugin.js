"use strict";
/**
 * OpenClaw Channel Plugin for Webex
 *
 * Implements the ChannelPlugin interface for OpenClaw's plugin system.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.webexPlugin = void 0;
exports.setPluginRuntime = setPluginRuntime;
const send_1 = require("./send");
const webhook_1 = require("./webhook");
const download_1 = require("./download");
const progress_1 = require("./progress");
const people_cache_1 = require("./people-cache");
const formatters_1 = require("./formatters");
const websocket_1 = require("./websocket");
const card_builder_1 = require("./card-builder");
/** Quick-command buttons appended to every command reply card. */
const QUICK_COMMANDS = [
    { title: "📊 Status", command: "/status" },
    { title: "❓ Help", command: "/help" },
    { title: "🗜 Compact", command: "/compact" },
    { title: "🆕 New session", command: "/new" },
];
/**
 * Fully interactive picker for /model: a dropdown of the models the
 * gateway actually allows (agents.defaults.modelPolicy.allow — the
 * authoritative list, not parsed from reply prose) plus a Switch
 * button. Returns false when the config offers no model list, letting
 * the caller fall back to the plain command card.
 */
/**
 * Resolve the gateway's allowed-model list. Prefers the runtime config
 * object; falls back to reading the gateway config file directly, since
 * the plugin runtime's config view has not been reliable for sections
 * outside the plugin's own scope.
 */
function resolveModelAllowList(cfg) {
    const fromRuntime = cfg?.agents?.defaults?.modelPolicy?.allow;
    if (Array.isArray(fromRuntime) && fromRuntime.length > 0)
        return fromRuntime;
    try {
        const fs = require("node:fs");
        const path = require("node:path");
        const os = require("node:os");
        const configPath = process.env.OPENCLAW_CONFIG_PATH ??
            path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"), "openclaw.json");
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const fromFile = raw?.agents?.defaults?.modelPolicy?.allow;
        return Array.isArray(fromFile) ? fromFile : [];
    }
    catch {
        return [];
    }
}
async function deliverModelPickerCard(opts) {
    const allow = resolveModelAllowList(opts.cfg);
    if (allow.length === 0) {
        console.warn(`[webex:${opts.accountId}] /model picker skipped: no modelPolicy.allow list found in runtime config or config file`);
        return false;
    }
    const current = allow.find((m) => opts.replyText.includes(m));
    try {
        const card = (0, card_builder_1.commandPickerCard)({
            command: "/model",
            title: "/model — switch session model",
            bodyLines: opts.replyText.split("\n").slice(0, 6),
            choices: allow.map((m) => ({ title: m, value: m })),
            currentValue: current,
            submitTitle: "🔀 Switch model",
            quickCommands: [
                { title: "📊 Status", command: "/status" },
                { title: "❓ Help", command: "/help" },
            ],
        });
        (0, card_builder_1.validateForWebex)(card);
        await opts.sender.send({
            to: opts.roomId,
            content: { text: opts.replyText, card },
            parentId: opts.parentId,
        });
        return true;
    }
    catch (err) {
        console.warn(`[webex:${opts.accountId}] model picker card failed, falling back: ${err instanceof Error ? err.message : err}`);
        return false;
    }
}
/**
 * Deliver a slash-command reply as an Adaptive Card with tap-to-run
 * quick-command buttons. Falls back to plain chunked text if the card
 * fails validation or the send is rejected (e.g. body too large).
 */
async function deliverCommandReplyCard(opts) {
    // Toggle-style commands get their on/off choices as buttons instead of
    // the generic quick-command row.
    const isThinkToggle = opts.command === "/think" ||
        opts.command === "/thinking" ||
        opts.command === "/reasoning";
    const quickCommands = isThinkToggle
        ? [
            { title: "🧠 Think on", command: "/think on" },
            { title: "💤 Think off", command: "/think off" },
            { title: "📊 Status", command: "/status" },
        ]
        : QUICK_COMMANDS;
    try {
        const card = (0, card_builder_1.commandReplyCard)({
            command: opts.command,
            body: opts.replyText,
            quickCommands,
        });
        (0, card_builder_1.validateForWebex)(card);
        await opts.sender.send({
            to: opts.roomId,
            content: { text: opts.replyText, card },
            parentId: opts.parentId,
        });
        return;
    }
    catch (err) {
        console.warn(`[webex:${opts.accountId}] command card delivery failed, falling back to text: ${err instanceof Error ? err.message : err}`);
    }
    await deliverChunked({
        sender: opts.sender,
        roomId: opts.roomId,
        parentId: opts.parentId,
        replyText: opts.replyText,
        roomType: opts.roomType,
        authorId: opts.authorId,
        authorDisplayName: opts.authorDisplayName,
        accountId: opts.accountId,
    });
}
/**
 * Run `fn` outside the gateway's inherited root-work admission context.
 *
 * Since OpenClaw 2026.8.1, every task runs under a "root work" admission lease
 * tracked through an AsyncLocalStorage on a well-known global symbol. Webhook
 * handlers are registered during gateway startup, so incoming Webex requests
 * inherit the startup lease — which is released once boot completes. Core
 * dispatch then rejects the message with GatewayDrainingError even though the
 * gateway is healthy. Detaching from the stale store lets dispatch be admitted
 * as fresh root work. On cores without the admission singleton (<= 2026.7)
 * this is a plain passthrough.
 */
function runDetachedFromRootWorkAdmission(fn) {
    const state = globalThis[Symbol.for("openclaw.gatewayWorkAdmissionState")];
    const als = state?.currentRootWork;
    if (als && typeof als.exit === "function" && als.getStore?.()) {
        return als.exit(fn);
    }
    return fn();
}
/**
 * Truncate a string to a max length with an ellipsis. Leaves room for the
 * trailing "…" so the result never exceeds the limit.
 */
function truncate(s, max = 80) {
    if (s.length <= max)
        return s;
    return s.slice(0, Math.max(0, max - 1)) + "…";
}
/**
 * Redact obvious secret-shaped tokens from free-form text before it
 * reaches Webex. Deliberately conservative — catches the common shapes
 * (Bearer tokens, AWS keys, GitHub PATs, long opaque strings with the
 * word "token"/"key"/"password" nearby) rather than trying to be clever.
 */
function redactSecrets(s) {
    return s
        .replace(/Bearer\s+[A-Za-z0-9_\-.]{10,}/gi, "Bearer <redacted>")
        .replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]+/gi, "$1=<redacted>")
        .replace(/AKIA[0-9A-Z]{16}/g, "<redacted-aws-key>")
        .replace(/ghp_[A-Za-z0-9]{30,}/g, "<redacted-github-pat>")
        .replace(/ghs_[A-Za-z0-9]{30,}/g, "<redacted-github-token>");
}
/**
 * Per-tool formatter. Produces a plain-text one-liner alongside a Webex
 * markdown variant that bolds the verb and code-quotes the detail —
 * "Reading `/home/claw/MEMORY.md`", "**Running**: `git status`".
 *
 *no emoji — the progress message is meant to
 * read like a status line, not a chat sticker pack. Users asked for the
 * actual command text ("I want to see the commands it is running", not
 * just "exec").
 *
 *returns text + markdown so Webex desktop/web
 * clients render the verb in bold and the detail monospace-quoted.
 */
function formatToolStart(evt) {
    const name = evt.name ?? "tool";
    const raw = evt.summary ?? pickToolDetail(name, evt.input);
    if (!raw) {
        return { text: `Running ${name}…`, markdown: `Running *${name}*…` };
    }
    const detail = truncate(redactSecrets(raw), 160);
    return formatToolLine(name, detail);
}
/**
 * Compose the per-tool phrasing. Separate from pickToolDetail so the
 * detail extraction and the surface wording can evolve independently.
 */
function formatToolLine(name, detail) {
    const q = (0, formatters_1.escapeMarkdown)(detail);
    switch (name) {
        case "Read":
        case "NotebookEdit":
            return {
                text: `Reading ${detail}`,
                markdown: `**Reading** \`${q}\``,
            };
        case "Write":
            return {
                text: `Writing ${detail}`,
                markdown: `**Writing** \`${q}\``,
            };
        case "Edit":
            return {
                text: `Editing ${detail}`,
                markdown: `**Editing** \`${q}\``,
            };
        case "Bash":
            return {
                text: `Running: ${detail}`,
                markdown: `**Running** \`${q}\``,
            };
        case "Grep":
            return {
                text: `Searching for: ${detail}`,
                markdown: `**Searching for** \`${q}\``,
            };
        case "Glob":
            return {
                text: `Listing files matching: ${detail}`,
                markdown: `**Listing files matching** \`${q}\``,
            };
        case "WebFetch":
            return {
                text: `Fetching ${detail}`,
                markdown: `**Fetching** \`${q}\``,
            };
        case "WebSearch":
            return {
                text: `Searching web: ${detail}`,
                markdown: `**Searching web** for \`${q}\``,
            };
        case "Agent":
            return {
                text: `Spawning agent: ${detail}`,
                markdown: `**Spawning agent**: *${q}*`,
            };
        default:
            if (name.includes("rag") || name.startsWith("cisco-rag")) {
                return {
                    text: `cisco-rag: ${detail}`,
                    markdown: `**cisco-rag** \`${q}\``,
                };
            }
            return {
                text: `${name}: ${detail}`,
                markdown: `**${(0, formatters_1.escapeMarkdown)(name)}** \`${q}\``,
            };
    }
}
function pickToolDetail(name, input) {
    if (!input)
        return undefined;
    const s = (k) => {
        const v = input[k];
        return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    switch (name) {
        case "Read":
        case "NotebookEdit":
            return s("file_path");
        case "Write":
        case "Edit":
            return s("file_path");
        case "Bash":
            return s("command");
        case "Grep":
            return s("pattern");
        case "Glob":
            return s("pattern");
        case "WebFetch":
        case "WebSearch":
            return s("url") ?? s("query");
        case "Agent":
            return s("description");
        default:
            // Common fallback keys used by a lot of MCP tools.
            return (s("query") ??
                s("command") ??
                s("path") ??
                s("file_path") ??
                s("url") ??
                s("pattern") ??
                s("description"));
    }
}
/**
 * Build the `GetReplyOptions` hooks that drive the live progress indicator.
 *
 * - "minimal": no additional hooks — only the initial placeholder shows.
 * - "detailed" (default): thinking, tool starts, commands, plan updates,
 *   approvals, and writing transitions are all posted.
 * - "silent" never reaches this function (progress is undefined).
 *
 * `streamReasoning` (opt-in) makes onReasoningStream show a rolling tail
 * of the model's reasoning text instead of the static "💭 Thinking…"
 * label. Throttled to ~1 update per REASONING_THROTTLE_MS so a 30s
 * thinking block doesn't flood Webex; coalescing in progress.ts and the
 * send-side rate limiter add further safety.
 */
function buildProgressReplyOptions(progress, verbosity, streamReasoning) {
    if (!progress)
        return {};
    if (verbosity === "minimal")
        return {};
    // Per-dispatch reasoning state. Lives in this closure, so a new
    // buildProgressReplyOptions call (new webhook) starts fresh.
    const REASONING_TAIL_CHARS = 240;
    const REASONING_BUFFER_MAX = REASONING_TAIL_CHARS * 4;
    const REASONING_THROTTLE_MS = 1500;
    let reasoningBuffer = "";
    let reasoningLastEmittedAt = 0;
    let reasoningTimer;
    const clearReasoningTimer = () => {
        if (reasoningTimer) {
            clearTimeout(reasoningTimer);
            reasoningTimer = undefined;
        }
    };
    const resetReasoning = () => {
        clearReasoningTimer();
        reasoningBuffer = "";
    };
    const emitReasoning = () => {
        reasoningTimer = undefined;
        reasoningLastEmittedAt = Date.now();
        if (!reasoningBuffer) {
            progress.update("Thinking…", "*Thinking…*");
            return;
        }
        // Walk back to a safe markdown boundary before slicing — avoids
        // leaving a dangling backtick / fence inside the rendered tail.
        const safeBuffer = (0, formatters_1.trimToSafeMarkdownBoundary)(reasoningBuffer);
        const tail = safeBuffer.length > REASONING_TAIL_CHARS
            ? "…" + safeBuffer.slice(-REASONING_TAIL_CHARS)
            : safeBuffer;
        // Strip markdown syntax characters and collapse whitespace — the
        // tail is interpolated into a *italic* context, so stray ticks or
        // asterisks would break rendering.
        const clean = (0, formatters_1.stripMarkdownSyntax)(redactSecrets(tail));
        if (!clean) {
            progress.update("Thinking…", "*Thinking…*");
            return;
        }
        progress.update(`Thinking: ${clean}`, `**Thinking** — *${(0, formatters_1.escapeMarkdown)(clean)}*`);
    };
    const scheduleReasoningEmit = () => {
        const elapsed = Date.now() - reasoningLastEmittedAt;
        if (elapsed >= REASONING_THROTTLE_MS) {
            clearReasoningTimer();
            emitReasoning();
            return;
        }
        if (!reasoningTimer) {
            reasoningTimer = setTimeout(emitReasoning, REASONING_THROTTLE_MS - elapsed);
        }
    };
    const emitReasoningLabel = () => {
        progress.update("Thinking…", "*Thinking…*");
    };
    return {
        onReasoningStream: (evt) => {
            if (!streamReasoning) {
                emitReasoningLabel();
                return;
            }
            const chunk = evt?.text ?? "";
            if (chunk) {
                reasoningBuffer += chunk;
                if (reasoningBuffer.length > REASONING_BUFFER_MAX) {
                    // Keep the tail — oldest reasoning is least useful.
                    reasoningBuffer = reasoningBuffer.slice(-REASONING_BUFFER_MAX / 2);
                }
            }
            scheduleReasoningEmit();
        },
        onReasoningEnd: () => {
            resetReasoning();
        },
        onToolStart: (evt) => {
            resetReasoning();
            const line = formatToolStart(evt);
            progress.update(line.text, line.markdown);
        },
        // onItemEvent fires for generic work items (often carries richer
        // `progressText` or `title` when `onCommandOutput` only has `name: "exec"`).
        // Users specifically asked to see the actual commands, not just "exec".
        onItemEvent: (evt) => {
            if (evt.status === "completed" || evt.status === "failed")
                return;
            const detail = evt.progressText ?? evt.summary ?? evt.title;
            if (!detail)
                return;
            const label = evt.name && evt.name !== evt.kind ? evt.name : evt.kind;
            const clean = truncate(redactSecrets(detail), 200);
            const q = (0, formatters_1.escapeMarkdown)(clean);
            if (label && label !== "exec" && label !== "generic") {
                progress.update(`${label}: ${clean}`, `**${(0, formatters_1.escapeMarkdown)(label)}** \`${q}\``);
            }
            else {
                progress.update(clean, `\`${q}\``);
            }
        },
        onCommandOutput: (evt) => {
            if (evt.status === "completed" || evt.status === "failed")
                return;
            // Prefer the actual command text over the generic tool label.
            // Users complained about seeing bare "exec" when the real info is
            // in evt.command.
            const command = evt.command ?? evt.summary;
            if (command) {
                const clean = truncate(redactSecrets(command), 200);
                progress.update(`Running: ${clean}`, `**Running** \`${(0, formatters_1.escapeMarkdown)(clean)}\``);
            }
            else if (evt.name && evt.name !== "exec") {
                progress.update(`Running ${evt.name}…`, `Running *${(0, formatters_1.escapeMarkdown)(evt.name)}*…`);
            }
        },
        onPlanUpdate: ({ title }) => {
            if (title) {
                const clean = truncate(title, 200);
                progress.update(`Plan: ${clean}`, `**Plan**: ${(0, formatters_1.escapeMarkdown)(clean)}`);
            }
        },
        onApprovalEvent: ({ status, title }) => {
            if (status === "pending" && title) {
                const clean = truncate(title, 160);
                progress.update(`Waiting for approval: ${clean}`, `**Waiting for approval** — ${(0, formatters_1.escapeMarkdown)(clean)}`);
            }
        },
        onAssistantMessageStart: () => {
            resetReasoning();
            progress.update("Writing response…", "*Writing response…*");
        },
    };
}
// Per-account people cache keyed by accountId. Scoping by account means
// two bots with different tokens don't try to share bearer credentials.
const peopleCaches = new Map();
function getPeopleCache(accountId, apiBaseUrl) {
    let cache = peopleCaches.get(accountId);
    if (!cache) {
        cache = (0, people_cache_1.createPeopleCache)({ apiBaseUrl });
        peopleCaches.set(accountId, cache);
    }
    return cache;
}
// Store the plugin runtime for use in HTTP handlers
let pluginRuntime = null;
function setPluginRuntime(runtime) {
    pluginRuntime = runtime;
}
const DEFAULT_ACCOUNT_ID = "default";
/**
 * Deliver an agent reply, splitting into 7439-byte-safe chunks and
 * threading follow-up chunks under the first. Auto-@mentions the
 * requester on the first chunk in group rooms so the user gets a
 * notification; DMs skip the mention (Webex ignores it there anyway).
 *
 */
async function deliverChunked(opts) {
    const { sender, roomId, parentId, replyText, roomType, authorId, authorDisplayName, accountId, } = opts;
    const mention = roomType === "group" && authorId
        ? (0, formatters_1.mentionMarkdown)(authorId, authorDisplayName)
        : "";
    // Rewrite unsupported markdown (pipe-tables) before we chunk, so the
    // reply reads as aligned code blocks on Webex instead of literal
    // pipe characters.
    const rewritten = (0, formatters_1.transformMarkdownForWebex)(replyText);
    const chunks = (0, formatters_1.splitForWebex)(rewritten);
    const shouldUseMarkdown = (0, formatters_1.looksMarkdown)(rewritten) || mention.length > 0;
    // Thread 2..N replies under the first Webex message we post, so the
    // chunks read as one logical response rather than scattered messages.
    let firstMessageId;
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isFirst = i === 0;
        const text = isFirst && mention
            ? `${authorDisplayName ?? ""} ${chunk}`.trim()
            : chunk;
        const markdownBody = isFirst && mention ? `${mention} ${chunk}` : chunk;
        const markdown = shouldUseMarkdown ? markdownBody : undefined;
        try {
            const sent = await sender.send({
                to: roomId,
                content: markdown ? { text, markdown } : { text },
                parentId: isFirst ? parentId : firstMessageId ?? parentId,
            });
            if (isFirst && sent?.id) {
                firstMessageId = sent.id;
            }
        }
        catch (err) {
            console.warn(`[webex:${accountId}] reply chunk ${i + 1}/${chunks.length} failed: ${err instanceof Error ? err.message : err}`);
            // Abort the rest — better to stop than spam partial chunks.
            return;
        }
    }
}
/**
 * Run everything the webhook handler used to do inline — attachment
 * download, ctxPayload build, dispatch with progress reporter — but
 * detached from the HTTP response so Webex can ACK within ~10 s.
 *
 * All errors are logged or surfaced as progress messages; nothing
 * propagates back up the stack.
 */
async function processEnvelopeAsync(opts) {
    const { envelope, account, runtime } = opts;
    const cfg = runtime.config?.loadConfig?.() ?? {};
    // Download inbound attachments eagerly. Webex file URLs require the
    // bot token, and OpenClaw core expects local paths.
    const downloaded = [];
    for (const attachment of envelope.content.attachments ?? []) {
        if (attachment.type !== "file" || !attachment.url)
            continue;
        try {
            const result = await (0, download_1.downloadWebexAttachment)(attachment.url, account.config.token);
            if (!result)
                continue;
            attachment.localPath = result.localPath;
            attachment.contentType = result.contentType;
            attachment.name = result.name;
            attachment.size = result.size;
            downloaded.push(result);
        }
        catch (err) {
            console.warn(`[webex:${account.accountId}] attachment download failed: ${err instanceof Error ? err.message : err}`);
        }
    }
    const mediaPaths = downloaded.map((d) => d.localPath);
    const mediaTypes = downloaded
        .map((d) => d.contentType)
        .filter((ct) => Boolean(ct));
    // Which agent receives this dispatch. Defaults to "main" so existing
    // single-account deployments keep working. Per-account binding is
    // Phase 1.5 — see resolveWebexAccount.
    const agentId = typeof account.config.agent === "string" && account.config.agent.length > 0
        ? account.config.agent
        : "main";
    // Resolve the sender's displayName via GET /people/{id}, with a
    // cached best-effort fallback to email/id.
    // previously always undefined because normalizeMessage didn't have
    // token context to make the extra API call.
    if (!envelope.author.displayName && envelope.author.id) {
        try {
            const people = getPeopleCache(account.accountId, account.config.apiBaseUrl);
            const displayName = await people.getDisplayName(envelope.author.id, account.config.token);
            if (displayName) {
                envelope.author.displayName = displayName;
            }
        }
        catch {
            // people-cache swallows its own errors; this catch is belt-and-braces.
        }
    }
    // Prefer the markdown form when Webex gave us one — users who bolded
    // or code-quoted parts of their message deserve to have that preserved
    // in ctxPayload's Body.upstream dropped the
    // markdown field even though webhook.ts normalises it into the envelope.
    const inboundText = envelope.content.markdown && envelope.content.markdown.length > 0
        ? envelope.content.markdown
        : envelope.content.text ?? "";
    const ctxPayload = {
        Body: inboundText,
        RawBody: inboundText,
        CommandBody: envelope.content.text ?? inboundText,
        BodyMarkdown: envelope.content.markdown ?? undefined,
        From: `webex:${envelope.author.id}`,
        To: `webex:${envelope.conversationId}`,
        SessionKey: `agent:${agentId}:webex:${envelope.conversationId}`,
        AccountId: account.accountId,
        ChatType: envelope.metadata.roomType === "direct" ? "direct" : "group",
        SenderName: envelope.author.displayName ?? envelope.author.email ?? envelope.author.id,
        SenderId: envelope.author.id,
        Provider: "webex",
        Surface: "webex",
        MessageSid: envelope.id,
        Timestamp: envelope.metadata.timestamp,
        OriginatingChannel: "webex",
        OriginatingTo: `webex:${envelope.conversationId}`,
        MessageThreadId: envelope.metadata.parentId,
        // Slash-command authorization (/status, /new, /compact, …). Core
        // requires the channel to vouch for the sender; without this flag
        // commands are silently swallowed. Any envelope that reaches this
        // point has already passed the plugin's default-deny allowlist, so
        // "allowlisted sender" ⇒ command-authorized — the same semantics
        // the bundled Telegram/Discord channels apply to their allowlists.
        CommandAuthorized: true,
    };
    if (mediaPaths.length > 0) {
        ctxPayload.MediaPath = mediaPaths[0];
        ctxPayload.MediaUrl = mediaPaths[0];
        ctxPayload.MediaType = downloaded[0].contentType;
        ctxPayload.MediaPaths = mediaPaths;
        ctxPayload.MediaUrls = mediaPaths;
        ctxPayload.MediaTypes = mediaTypes;
    }
    const dispatchReply = runtime.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
    if (!dispatchReply) {
        console.warn(`[webex:${account.accountId}] dispatchReply not available in plugin runtime`);
        cleanupTempFiles(downloaded, account.accountId);
        return;
    }
    const sender = new send_1.WebexSender(account.config);
    const verbosity = account.config.progressVerbosity ?? "detailed";
    // Slash-command turns (/status, /help, …) are answered synchronously by
    // core without an agent run — a "Working on it…" placeholder is pure
    // noise there, so suppress progress reporting entirely for them. The
    // bot mention has already been stripped by the event handler, so a
    // command arrives as leading "/".
    const isCommandTurn = (envelope.content.text ?? "").trimStart().startsWith("/");
    const commandName = isCommandTurn
        ? (envelope.content.text ?? "").trimStart().split(/\s+/)[0]
        : undefined;
    const showPlaceholder = !isCommandTurn &&
        account.config.showProgressPlaceholder !== false && verbosity !== "silent";
    const placeholderText = account.config.progressPlaceholderText ?? "Working on it…";
    const progress = showPlaceholder
        ? (0, progress_1.createProgressReporter)({
            sender,
            to: envelope.conversationId,
            parentId: envelope.metadata.parentId,
            onWarn: (err) => console.warn(`[webex:${account.accountId}] progress update failed: ${err instanceof Error ? err.message : err}`),
        })
        : undefined;
    progress?.update(placeholderText, `*${placeholderText}*`);
    const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;
    const heartbeatMs = account.config.progressHeartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const startedAt = Date.now();
    let heartbeatTimer;
    if (progress && heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
            const elapsedMin = Math.round((Date.now() - startedAt) / 60000);
            const plain = `Still working on it… (${elapsedMin} min elapsed)`;
            progress.update(plain, `*${plain}*`);
        }, heartbeatMs);
    }
    let replyDelivered = false;
    let errorPosted = false;
    const postErrorMessage = async () => {
        if (replyDelivered || errorPosted)
            return;
        errorPosted = true;
        await progress?.close().catch(() => { });
        try {
            const errText = "Something went wrong while processing your request. " +
                "Please try again, or use /new to start a fresh session.";
            await sender.send({
                to: envelope.conversationId,
                content: {
                    text: errText,
                    markdown: `⚠️ ${errText}`,
                },
                parentId: envelope.metadata.parentId,
            });
        }
        catch (err) {
            console.warn(`[webex:${account.accountId}] failed to post error message: ${err instanceof Error ? err.message : err}`);
        }
    };
    try {
        await runDetachedFromRootWorkAdmission(() => dispatchReply({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
                deliver: async (payload) => {
                    if (payload.text) {
                        if (isCommandTurn && commandName === "/model") {
                            // /model gets a fully interactive picker; falls through to
                            // the generic command card only if config has no model list.
                            const handled = await deliverModelPickerCard({
                                cfg,
                                sender,
                                roomId: envelope.conversationId,
                                parentId: envelope.metadata.parentId,
                                replyText: payload.text,
                                accountId: account.accountId,
                            });
                            if (handled) {
                                replyDelivered = true;
                                await progress?.close();
                                return;
                            }
                        }
                        if (isCommandTurn && commandName) {
                            // Command replies render as an Adaptive Card with
                            // quick-command buttons; falls back to text on failure.
                            await deliverCommandReplyCard({
                                sender,
                                roomId: envelope.conversationId,
                                parentId: envelope.metadata.parentId,
                                command: commandName,
                                replyText: payload.text,
                                roomType: envelope.metadata.roomType,
                                authorId: envelope.author.id,
                                authorDisplayName: envelope.author.displayName,
                                accountId: account.accountId,
                            });
                        }
                        else {
                            await deliverChunked({
                                sender,
                                roomId: envelope.conversationId,
                                parentId: envelope.metadata.parentId,
                                replyText: payload.text,
                                roomType: envelope.metadata.roomType,
                                authorId: envelope.author.id,
                                authorDisplayName: envelope.author.displayName,
                                accountId: account.accountId,
                            });
                        }
                        replyDelivered = true;
                    }
                    await progress?.close();
                },
                onError: (err) => {
                    console.error(`[webex:${account.accountId}] reply dispatch error: ${err.message}`);
                    postErrorMessage().catch(() => { });
                },
            },
            replyOptions: buildProgressReplyOptions(progress, verbosity, Boolean(account.config.progressStreamReasoning)),
        }));
        // Don't speculatively post an apology when `deliver` saw no text payload.
        // OpenClaw's runtime can route replies through the `message` tool, which
        // delivers to Webex directly and bypasses this dispatcher's `deliver`
        // callback — so `replyDelivered` stays false even on success. Real
        // failures already surface via `onError` (above) and the catch block
        // (below); both call postErrorMessage() explicitly.
    }
    catch (err) {
        console.error(`[webex:${account.accountId}] dispatchReply threw: ${err instanceof Error ? err.message : err}`);
        await postErrorMessage();
    }
    finally {
        if (heartbeatTimer)
            clearInterval(heartbeatTimer);
        if (replyDelivered)
            await progress?.close().catch(() => { });
        cleanupTempFiles(downloaded, account.accountId);
    }
}
/**
 * Turn an AdaptiveCard submission into a synthetic OpenClaw envelope
 * and dispatch it to the same agent the user is already talking to in
 * this room. Lets a bot post a card, the user press a button, and the
 * agent continue the conversation without any separate wiring.
 *
 *
 * Routing:
 *   - If the card's Action.Submit data included a `__openclawSessionKey`
 *     field, use it verbatim — lets a bot target a specific cross-room
 *     session (e.g. card posted in one room submitting back into a
 *     long-running operational session in another room).
 *   - Otherwise, build a room-local SessionKey the same way the inbound
 *     message path does.
 */
/**
 * Execute a slash command triggered by a card button, replying with a
 * fresh command card. Mirrors the message-path command dispatch: the
 * submitter has already passed the allowlist gate, so the context is
 * marked CommandAuthorized.
 */
async function dispatchCommandFromCard(opts) {
    const { account, runtime, cfg, command, roomId, parentId, personId, displayName, agentId } = opts;
    const dispatchReply = runtime.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
    if (!dispatchReply)
        return;
    const sender = new send_1.WebexSender(account.config);
    const ctxPayload = {
        Body: command,
        RawBody: command,
        CommandBody: command,
        From: `webex:${personId}`,
        To: `webex:${roomId}`,
        SessionKey: `agent:${agentId}:webex:${roomId}`,
        AccountId: account.accountId,
        ChatType: "group",
        SenderName: displayName ?? personId,
        SenderId: personId,
        Provider: "webex",
        Surface: "webex",
        OriginatingChannel: "webex",
        OriginatingTo: `webex:${roomId}`,
        MessageThreadId: parentId,
        CommandAuthorized: true,
    };
    try {
        await runDetachedFromRootWorkAdmission(() => dispatchReply({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
                deliver: async (payload) => {
                    if (!payload.text)
                        return;
                    const baseCommand = command.split(/\s+/)[0];
                    if (baseCommand === "/model") {
                        const handled = await deliverModelPickerCard({
                            cfg,
                            sender,
                            roomId,
                            parentId,
                            replyText: payload.text,
                            accountId: account.accountId,
                        });
                        if (handled)
                            return;
                    }
                    await deliverCommandReplyCard({
                        sender,
                        roomId,
                        parentId,
                        command: baseCommand,
                        replyText: payload.text,
                        roomType: "group",
                        authorId: personId,
                        authorDisplayName: displayName,
                        accountId: account.accountId,
                    });
                },
                onError: (err) => {
                    console.error(`[webex:${account.accountId}] card command dispatch error: ${err.message}`);
                },
            },
        }));
    }
    catch (err) {
        console.error(`[webex:${account.accountId}] card command dispatch threw: ${err instanceof Error ? err.message : err}`);
    }
}
/**
 * Format a Date as "YYYY-MM-DD HH:MM" in UTC, for the card-rewrite
 * footer line.
 */
function formatUtcTimestamp(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/**
 * Extract the Adaptive Card content from a fetched message, or undefined
 * if the first attachment isn't a genuine adaptive card. Webex's JSON
 * response is untyped at the network boundary, so this is a runtime
 * check, not just type narrowing — shared by the single-use gate and
 * rewriteSourceCardAsUsed so both apply the identical guard.
 */
function extractCardContent(message) {
    const attachment = message.attachments?.[0];
    const content = attachment?.content;
    if (!attachment ||
        attachment.contentType !== "application/vnd.microsoft.card.adaptive" ||
        !content ||
        content.type !== "AdaptiveCard") {
        return undefined;
    }
    return content;
}
/**
 * Rewrite the card message a button click just came from into its
 * deadened "used" form — actions gone, inputs replaced by what was
 * chosen, a footer naming who acted and when — so the room reads as an
 * audit log and the card can't be double-clicked. Called fire-and-forget
 * from both processAttachmentActionAsync branches, BEFORE the command/
 * agent dispatch, so the card deadens immediately even if the dispatch
 * takes seconds. Every failure path only logs — a broken edit must never
 * take down the actual command/submission handling.
 *
 * Takes the already-fetched source message (the caller GETs it once, up
 * front, to also run the single-use gate — see processAttachmentActionAsync)
 * instead of fetching it again here, and the caller's already-constructed
 * WebexSender rather than building a second one.
 */
async function rewriteSourceCardAsUsed(opts) {
    const { account, action, message, summary, sender } = opts;
    try {
        const content = extractCardContent(message);
        if (!content)
            return; // not a genuine adaptive-card message — nothing to rewrite
        const finalized = (0, card_builder_1.finalizeUsedCard)(content, {
            summary,
            inputs: action.inputs,
        });
        if (!finalized) {
            console.log(`[webex:${account.accountId}] skipping card rewrite for ${action.messageId}: card contains an image, Webex cannot edit it`);
            return;
        }
        // Catch a malformed finalized card locally rather than let Webex's
        // PUT surface a generic HTTP 400 — same reasoning validateForWebex
        // exists for POST /messages elsewhere in this codebase.
        (0, card_builder_1.validateForWebex)(finalized);
        // Preserve the original text fallback rather than clobbering it —
        // clients that render only `text` should still see what the card
        // said, plus the new outcome line.
        const fallbackText = `${message.text ?? ""}\n${summary}`.trim().slice(0, 7000);
        await sender.updateCardMessage(action.messageId, {
            roomId: action.roomId,
            text: fallbackText,
            card: finalized,
        });
    }
    catch (err) {
        console.warn(`[webex:${account.accountId}] card rewrite failed for ${action.messageId}: ${err instanceof Error ? err.message : err}`);
    }
}
async function processAttachmentActionAsync(opts) {
    const { action, account, runtime } = opts;
    const cfg = runtime.config?.loadConfig?.() ?? {};
    const agentId = typeof account.config.agent === "string" && account.config.agent.length > 0
        ? account.config.agent
        : "main";
    // AUTHORIZATION — gates every attachment-action submission, command
    // buttons AND generic card submissions alike, before any fetch,
    // dispatch, or card rewrite happens. Previously this check lived
    // inside the commandFromCard branch only, so generic card submissions
    // bypassed the allowlist entirely; tightened here to close that gap.
    // Same semantics as the message path: dmPolicy "allow" authorizes
    // everyone, "allowlisted" checks personId or any of the submitter's
    // emails against allowFrom, anything else denies.
    {
        let authorized = false;
        const policy = account.config.dmPolicy;
        if (policy === "allow") {
            authorized = true;
        }
        else if (policy === "allowlisted") {
            const allowFrom = account.config.allowFrom ?? [];
            if (allowFrom.includes(action.personId)) {
                authorized = true;
            }
            else {
                try {
                    const people = getPeopleCache(account.accountId, account.config.apiBaseUrl);
                    const emails = (await people.getEmails(action.personId, account.config.token)) ??
                        [];
                    authorized = emails.some((e) => allowFrom.includes(e));
                }
                catch {
                    authorized = false;
                }
            }
        }
        if (!authorized) {
            console.warn(`[webex:${account.accountId}] dropped card action from unauthorized submitter`);
            return;
        }
    }
    // Resolve submitter's display name — best-effort; same cache the
    // message path uses, so lookups reuse cached results.
    let displayName;
    try {
        const people = getPeopleCache(account.accountId, account.config.apiBaseUrl);
        displayName = await people.getDisplayName(action.personId, account.config.token);
    }
    catch {
        // ignore — downstream handles missing name gracefully
    }
    const sender = new send_1.WebexSender(account.config);
    // Single-use enforcement: fetch the source card once (reused below for
    // the rewrite — never GET twice) and drop the submission outright if
    // it's already carrying finalizeUsedCard's "used" marker, meaning a
    // prior click already deadened it. Best-effort, not transactional: two
    // clicks landing within the GET's API latency can both pass this
    // check before either rewrite completes, so a determined double-click
    // can still slip through. This closes the common case (a slow agent
    // reply tempting a second tap on a still-live-looking card), not every
    // race. This GET sits on the critical path of every card click, so it
    // gets a minimal retry budget (1) rather than inheriting the sender's
    // full outbound-delivery retry/backoff chain — it's a best-effort
    // check, not a delivery that's worth blocking dispatch over.
    let sourceMessage;
    try {
        sourceMessage = await sender.getMessage(action.messageId, { maxRetries: 1 });
    }
    catch (err) {
        console.warn(`[webex:${account.accountId}] failed to fetch source card ${action.messageId}: ${err instanceof Error ? err.message : err}`);
    }
    if (sourceMessage) {
        const sourceCard = extractCardContent(sourceMessage);
        if (sourceCard && (0, card_builder_1.cardAlreadyUsed)(sourceCard)) {
            console.log(`[webex:${account.accountId}] dropped card action ${action.id}: source card ${action.messageId} already marked used`);
            return;
        }
    }
    // AIOps approval cards: the AIOps dashboard (a separate service) posts
    // Adaptive Cards whose Action.Submit data carries
    // `{intent: "aiops-approval", evalId, decision}` plus an optional
    // user-typed `notes` input. These submissions are handled
    // deterministically here — no agent dispatch — by calling the
    // dashboard's approve/reject API directly and rewriting the card as
    // the audit record. This branch owns its card rewrite exclusively: it
    // always returns before falling through to the commandFromCard or
    // generic-submission branches below, so neither of those can also
    // rewrite the same card for an aiops-approval action.
    if (action.inputs.intent === "aiops-approval") {
        const rawEvalId = action.inputs.evalId;
        const evalId = typeof rawEvalId === "string" ? rawEvalId : "";
        const decision = action.inputs.decision;
        // Reject an all-dots value (".", "..", "...") in addition to the
        // general charset check — closes a path-normalization primitive the
        // dashboard's URL-based routing would otherwise be vulnerable to.
        const evalIdValid = /^[A-Za-z0-9_.:-]{1,64}$/.test(evalId) && !/^\.+$/.test(evalId);
        const decisionValid = decision === "approve" || decision === "reject";
        if (!evalIdValid || !decisionValid) {
            console.warn(`[webex:${account.accountId}] dropped aiops-approval action ${action.id}: invalid evalId (${JSON.stringify(rawEvalId)}) or decision (${JSON.stringify(decision)})`);
            return;
        }
        // Resolve actor identity: prefer the submitter's first email, then
        // their display name (already resolved above), then the raw personId.
        let actor = displayName ?? action.personId;
        try {
            const people = getPeopleCache(account.accountId, account.config.apiBaseUrl);
            const emails = await people.getEmails(action.personId, account.config.token);
            if (emails && emails.length > 0 && emails[0]) {
                actor = emails[0];
            }
        }
        catch {
            // fall back to the displayName/personId already assigned above
        }
        const notes = typeof action.inputs.notes === "string" && action.inputs.notes.length > 0
            ? action.inputs.notes.slice(0, 1000)
            : undefined;
        const approvalBase = typeof account.config.aiopsApprovalUrl === "string" &&
            account.config.aiopsApprovalUrl.length > 0
            ? account.config.aiopsApprovalUrl
            : "http://127.0.0.1:8765/api/v1";
        const url = `${approvalBase.replace(/\/+$/, "")}/evaluations/${encodeURIComponent(evalId)}/${decision}`;
        // Shared-secret auth, opt-in via config. Sent only as a request
        // header — never logged, never echoed into any card or chat message.
        const requestHeaders = {
            "Content-Type": "application/json",
        };
        if (typeof account.config.aiopsApprovalSecret === "string" &&
            account.config.aiopsApprovalSecret.length > 0) {
            requestHeaders["X-AIOps-Approval-Secret"] = account.config.aiopsApprovalSecret;
        }
        let ok = false;
        let httpStatus;
        let responseBody;
        let networkError = false;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: requestHeaders,
                // cardMessageId binds this decision to the specific card that was
                // clicked — the dashboard enforces it matches the evaluation's
                // approval_card_message_id, so a crafted submission naming an
                // arbitrary evalId can't be approved from an unrelated card.
                body: JSON.stringify({
                    user: actor,
                    notes,
                    cardMessageId: action.messageId,
                }),
                signal: AbortSignal.timeout(10_000),
            });
            httpStatus = res.status;
            ok = res.ok;
            // Best-effort, size-capped body parse on every response (not just
            // 2xx) — the success path uses it for the "upgrade" field, and
            // non-2xx branches below (409/404/422/401/403) may want detail
            // fields (e.g. `detail.code`) later without another round-trip.
            try {
                const rawText = await res.text();
                if (rawText && rawText.length <= 10_000) {
                    responseBody = JSON.parse(rawText);
                }
            }
            catch {
                responseBody = undefined;
            }
        }
        catch (err) {
            networkError = true;
            console.warn(`[webex:${account.accountId}] aiops-approval request errored for eval ${evalId} (decision=${decision}, actor=${actor}): ${err instanceof Error ? err.message : err}`);
        }
        const ts = formatUtcTimestamp(new Date());
        const safeActor = (0, formatters_1.escapeMarkdown)(truncate(actor, 80));
        if (ok) {
            const rewriteSummary = decision === "approve"
                ? `✅ Approved by ${safeActor} · ${ts} UTC`
                : `⛔ Rejected by ${safeActor} · ${ts} UTC`;
            if (sourceMessage) {
                void rewriteSourceCardAsUsed({
                    account,
                    action,
                    message: sourceMessage,
                    summary: rewriteSummary,
                    sender,
                });
            }
            const responseFields = responseBody && typeof responseBody === "object"
                ? responseBody
                : undefined;
            let confirmPlain;
            if (decision === "approve") {
                // The dashboard only enqueues the background upgrade task at
                // this point — it may still fail downstream — so this can't
                // claim the fixed "upgrade queued" text alongside a possibly
                // different response value (previously self-contradictory,
                // e.g. "upgrade queued (upgrade: dispatched)"). Use the
                // response's own word for what happened to the upgrade, else
                // fall back to "queued".
                const upgradeValue = typeof responseFields?.upgrade === "string" ? responseFields.upgrade : undefined;
                confirmPlain = `Evaluation ${evalId} approved by ${actor} — upgrade ${upgradeValue ?? "queued"}`;
            }
            else {
                // Reject confirmation is unchanged: surface a couple of response
                // fields if the dashboard trivially provided them, without
                // depending on any particular shape.
                const extras = [];
                if (typeof responseFields?.status === "string")
                    extras.push(`status: ${responseFields.status}`);
                if (typeof responseFields?.upgrade === "string")
                    extras.push(`upgrade: ${responseFields.upgrade}`);
                const extraSuffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
                confirmPlain = `Evaluation ${evalId} rejected by ${actor}${extraSuffix}`;
            }
            const icon = decision === "approve" ? "✅" : "⛔";
            try {
                await sender.send({
                    to: action.roomId,
                    content: {
                        text: `${icon} ${confirmPlain}`,
                        markdown: `${icon} ${(0, formatters_1.escapeMarkdown)(confirmPlain)}`,
                    },
                    parentId: action.messageId,
                });
            }
            catch (err) {
                console.warn(`[webex:${account.accountId}] aiops-approval confirmation post failed for eval ${evalId}: ${err instanceof Error ? err.message : err}`);
            }
        }
        else if (httpStatus === 409 || httpStatus === 404) {
            // Terminal outcomes — retrying can never succeed (the evaluation is
            // already decided, or no longer exists), so the card is deadened
            // just like a successful decision instead of staying live for an
            // endless "please try again" loop.
            const isConflict = httpStatus === 409;
            console.warn(`[webex:${account.accountId}] aiops-approval terminal ${httpStatus} for eval ${evalId} (decision=${decision}, actor=${actor}): ${isConflict ? "already decided" : "not found"}`);
            const rewriteSummary = isConflict
                ? `⚠️ Already decided · ${ts} UTC`
                : `⚠️ Evaluation not found · ${ts} UTC`;
            if (sourceMessage) {
                void rewriteSourceCardAsUsed({
                    account,
                    action,
                    message: sourceMessage,
                    summary: rewriteSummary,
                    sender,
                });
            }
            const noteText = isConflict
                ? `Evaluation ${evalId} was already decided — no action taken.`
                : `Evaluation ${evalId} not found — no action taken.`;
            try {
                await sender.send({
                    to: action.roomId,
                    content: {
                        text: `⚠️ ${noteText}`,
                        markdown: `⚠️ ${(0, formatters_1.escapeMarkdown)(noteText)}`,
                    },
                    parentId: action.messageId,
                });
            }
            catch (err) {
                console.warn(`[webex:${account.accountId}] aiops-approval terminal notice post failed for eval ${evalId}: ${err instanceof Error ? err.message : err}`);
            }
        }
        else if (httpStatus === 422) {
            // Non-terminal: the dashboard rejected this decision because the
            // clicked card isn't (or is no longer) the card bound to this
            // evaluation server-side (detail.code "card_not_bound" — a
            // duplicate card, or one that predates the approval system). No
            // decision was recorded, so unlike 409/404 the card must stay
            // live rather than be deadened; the click itself can't be retried
            // into success, though, so point the user at the dashboard API.
            console.warn(`[webex:${account.accountId}] aiops-approval card not bound to eval ${evalId} (decision=${decision}, actor=${actor}, httpStatus=422)`);
            const noteText = `This card is not bound to evaluation ${evalId} (it may predate the approval system or be a duplicate) — decide via the dashboard API instead.`;
            try {
                await sender.send({
                    to: action.roomId,
                    content: {
                        text: `⚠️ ${noteText}`,
                        markdown: `⚠️ ${(0, formatters_1.escapeMarkdown)(noteText)}`,
                    },
                    parentId: action.messageId,
                });
            }
            catch (err) {
                console.warn(`[webex:${account.accountId}] aiops-approval card-not-bound notice post failed for eval ${evalId}: ${err instanceof Error ? err.message : err}`);
            }
        }
        else if (httpStatus === 401 || httpStatus === 403) {
            // Non-terminal: an auth misconfiguration between the bot and the
            // dashboard (401 today, 403 after the dashboard's auth-failure
            // status change — handle both). Retrying the same click can't fix
            // this, so no retry framing; the card stays live since no
            // decision was actually recorded, and an operator needs to fix
            // the shared secret out-of-band.
            console.warn(`[webex:${account.accountId}] aiops-approval auth failure (HTTP ${httpStatus}) for eval ${evalId} (decision=${decision}, actor=${actor})`);
            const noteText = `Approval authentication is misconfigured between the bot and the dashboard — no decision was recorded. Contact ops.`;
            try {
                await sender.send({
                    to: action.roomId,
                    content: {
                        text: `⚠️ ${noteText}`,
                        markdown: `⚠️ ${(0, formatters_1.escapeMarkdown)(noteText)}`,
                    },
                    parentId: action.messageId,
                });
            }
            catch (err) {
                console.warn(`[webex:${account.accountId}] aiops-approval auth-failure notice post failed for eval ${evalId}: ${err instanceof Error ? err.message : err}`);
            }
        }
        else {
            // Retryable failure path — network errors/timeouts and any other
            // non-2xx (notably 5xx) never rewrite the card, so the click stays
            // retryable.
            console.warn(`[webex:${account.accountId}] aiops-approval NOT recorded for eval ${evalId} (decision=${decision}, actor=${actor}, httpStatus=${httpStatus ?? "n/a"}${networkError ? ", network error" : ""})`);
            const failPlain = `Could not record ${decision === "approve" ? "approval" : "rejection"} for evaluation ${evalId}${httpStatus ? ` (HTTP ${httpStatus})` : " (request failed)"}. Please try again.`;
            try {
                await sender.send({
                    to: action.roomId,
                    content: {
                        text: `⚠️ ${failPlain}`,
                        markdown: `⚠️ ${(0, formatters_1.escapeMarkdown)(failPlain)}`,
                    },
                    parentId: action.messageId,
                });
            }
            catch (err) {
                console.warn(`[webex:${account.accountId}] aiops-approval failure notice post failed for eval ${evalId}: ${err instanceof Error ? err.message : err}`);
            }
        }
        return;
    }
    // Tap-to-run command buttons: a card Action.Submit carrying
    // `__openclawCommand` executes that slash command as if the submitter
    // had typed it. Authorization for this was already checked above.
    const commandFromCard = (() => {
        const base = typeof action.inputs.__openclawCommand === "string" &&
            action.inputs.__openclawCommand.trimStart().startsWith("/")
            ? action.inputs.__openclawCommand.trim()
            : undefined;
        if (!base)
            return undefined;
        // Optional argument from a picker input (e.g. the /model dropdown).
        // Strictly validated: a single slug-shaped token, no whitespace or
        // shell/markup characters — it is joined into a command string that
        // runs with CommandAuthorized.
        const rawArg = typeof action.inputs.__openclawCommandArg === "string"
            ? action.inputs.__openclawCommandArg.trim()
            : undefined;
        const arg = rawArg && /^[A-Za-z0-9._/:@-]{1,120}$/.test(rawArg) ? rawArg : undefined;
        return arg ? `${base} ${arg}` : base;
    })();
    if (commandFromCard) {
        // Both interpolated values are markdown-escaped and length-capped —
        // the command string is only loosely validated (must start with
        // "/") and the display name comes from a Webex profile, so neither
        // is safe to drop straight into a TextBlock unescaped.
        const safeCommand = (0, formatters_1.escapeMarkdown)(truncate(commandFromCard, 140));
        const safeActor = (0, formatters_1.escapeMarkdown)(truncate(displayName ?? action.personId, 80));
        const commandSummary = `✅ ${safeCommand} — ${safeActor} · ${formatUtcTimestamp(new Date())} UTC`;
        if (sourceMessage) {
            void rewriteSourceCardAsUsed({
                account,
                action,
                message: sourceMessage,
                summary: commandSummary,
                sender,
            });
        }
        await dispatchCommandFromCard({
            account,
            runtime,
            cfg,
            command: commandFromCard,
            roomId: action.roomId,
            parentId: action.messageId,
            personId: action.personId,
            displayName,
            agentId,
        });
        return;
    }
    // Flatten the submission into a human- and LLM-friendly text block.
    // The agent will see this as the user's next message in the
    // conversation and can respond accordingly.
    const lines = [];
    lines.push(`[card-submission from ${displayName ?? action.personId}]`);
    for (const [k, v] of Object.entries(action.inputs)) {
        if (k.startsWith("__openclaw"))
            continue; // internal routing keys
        const display = typeof v === "string"
            ? v
            : v === null || v === undefined
                ? ""
                : JSON.stringify(v);
        if (display.length === 0)
            continue;
        lines.push(`${k}: ${display}`);
    }
    const submissionText = lines.join("\n");
    // SessionKey — honour explicit override on the card, otherwise route
    // to the same session as inbound messages in this room.
    const sessionKeyOverride = typeof action.inputs.__openclawSessionKey === "string"
        ? action.inputs.__openclawSessionKey
        : undefined;
    const sessionKey = sessionKeyOverride ?? `agent:${agentId}:webex:${action.roomId}`;
    const ctxPayload = {
        Body: submissionText,
        RawBody: submissionText,
        CommandBody: submissionText,
        From: `webex:${action.personId}`,
        To: `webex:${action.roomId}`,
        SessionKey: sessionKey,
        AccountId: account.accountId,
        ChatType: "group",
        SenderName: displayName ?? action.personId,
        SenderId: action.personId,
        Provider: "webex",
        Surface: "webex",
        MessageSid: action.id,
        Timestamp: action.created,
        OriginatingChannel: "webex",
        OriginatingTo: `webex:${action.roomId}`,
        MessageThreadId: action.messageId,
        // Exposed so skills can act on structured submission data without
        // re-parsing the summarised text.
        CardSubmission: {
            actionId: action.id,
            messageId: action.messageId,
            inputs: action.inputs,
        },
    };
    const dispatchReply = runtime.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
    if (!dispatchReply) {
        console.warn(`[webex:${account.accountId}] dispatchReply not available for card action`);
        return;
    }
    const safeActor = (0, formatters_1.escapeMarkdown)(truncate(displayName ?? action.personId, 80));
    const submissionSummary = `✅ Submitted by ${safeActor} · ${formatUtcTimestamp(new Date())} UTC`;
    if (sourceMessage) {
        void rewriteSourceCardAsUsed({
            account,
            action,
            message: sourceMessage,
            summary: submissionSummary,
            sender,
        });
    }
    try {
        await runDetachedFromRootWorkAdmission(() => dispatchReply({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
                deliver: async (payload) => {
                    if (payload.text) {
                        await deliverChunked({
                            sender,
                            roomId: action.roomId,
                            parentId: action.messageId,
                            replyText: payload.text,
                            roomType: "group",
                            authorId: action.personId,
                            authorDisplayName: displayName,
                            accountId: account.accountId,
                        });
                    }
                },
                onError: (err) => {
                    console.error(`[webex:${account.accountId}] card-action dispatch error: ${err.message}`);
                },
            },
        }));
    }
    catch (err) {
        console.error(`[webex:${account.accountId}] card-action dispatch threw: ${err instanceof Error ? err.message : err}`);
    }
}
/**
 * Delete attachment temp files after dispatch. Best-effort — any
 * failure is logged but never propagates.
 * previously the files just accumulated in os.tmpdir().
 */
function cleanupTempFiles(downloaded, accountId) {
    if (downloaded.length === 0)
        return;
    // Dynamic require to avoid hoisting fs to the top of the module.
    const { unlink } = require("node:fs/promises");
    for (const d of downloaded) {
        unlink(d.localPath).catch((err) => {
            console.warn(`[webex:${accountId}] temp file cleanup failed for ${d.localPath}: ${err instanceof Error ? err.message : err}`);
        });
    }
}
/**
 * Create the webhook handler with access to the plugin runtime.
 * Returns a handler function that can process incoming Webex webhook requests.
 */
/**
 * Dispatch a transport-synthesized (Mercury websocket) payload through
 * the exact pipeline the HTTP webhook endpoint uses: allowlist + bot
 * self-filter + message fetch in the handler, then the same async
 * dispatch into the agent. Signature verification is skipped — there is
 * no HTTP request to sign; the handler is constructed without a secret
 * in websocket mode.
 */
async function dispatchTransportPayload(opts) {
    const { payload, account, webhookHandler } = opts;
    if (!pluginRuntime)
        return;
    if (payload.resource === "attachmentActions") {
        const action = await webhookHandler.handleAttachmentAction(payload);
        if (action) {
            await processAttachmentActionAsync({
                action,
                account,
                runtime: pluginRuntime,
            });
        }
        return;
    }
    const envelope = await webhookHandler.handleWebhook(payload);
    if (envelope) {
        await processEnvelopeAsync({
            envelope,
            account,
            runtime: pluginRuntime,
        });
    }
}
function listWebexAccountIds(cfg) {
    const section = cfg.channels?.webex;
    if (!section)
        return [];
    const ids = [];
    // Check for top-level config (default account)
    if (section.token) {
        ids.push(DEFAULT_ACCOUNT_ID);
    }
    // Check for named accounts
    if (section.accounts) {
        for (const id of Object.keys(section.accounts)) {
            if (id !== DEFAULT_ACCOUNT_ID) {
                ids.push(id);
            }
        }
    }
    return ids;
}
function resolveWebexAccount(opts) {
    const { cfg, accountId = DEFAULT_ACCOUNT_ID } = opts;
    const section = cfg.channels?.webex;
    if (!section) {
        return {
            accountId,
            enabled: false,
            configured: false,
            config: {},
        };
    }
    // Check for named account first
    const namedAccount = section.accounts?.[accountId];
    if (namedAccount) {
        const token = namedAccount.token ?? section.token;
        return {
            accountId,
            name: namedAccount.name,
            // websocket transport: a token is all that's needed
            configured: Boolean(token),
            enabled: namedAccount.enabled !== false,
            token,
            config: {
                token: token ?? "",
                //default-deny. Upstream defaulted to
                // "allow", making the bot open to anyone by omission.
                dmPolicy: namedAccount.dmPolicy ?? section.dmPolicy ?? "deny",
                allowFrom: namedAccount.allowFrom ?? section.allowFrom,
                apiBaseUrl: namedAccount.apiBaseUrl ?? section.apiBaseUrl,
                maxRetries: namedAccount.maxRetries ?? section.maxRetries,
                retryDelayMs: namedAccount.retryDelayMs ?? section.retryDelayMs,
                showProgressPlaceholder: namedAccount.showProgressPlaceholder ?? section.showProgressPlaceholder,
                progressPlaceholderText: namedAccount.progressPlaceholderText ?? section.progressPlaceholderText,
                progressVerbosity: namedAccount.progressVerbosity ?? section.progressVerbosity,
                progressHeartbeatMs: namedAccount.progressHeartbeatMs ?? section.progressHeartbeatMs,
                //per-account agent binding. Named account
                // wins over section-level. Default "main" is applied by consumers
                // (e.g. processEnvelopeAsync) so the field stays strictly opt-in.
                agent: namedAccount.agent ?? section.agent,
                progressStreamReasoning: namedAccount.progressStreamReasoning ??
                    section.progressStreamReasoning,
                aiopsApprovalUrl: namedAccount.aiopsApprovalUrl ?? section.aiopsApprovalUrl,
                aiopsApprovalSecret: namedAccount.aiopsApprovalSecret ?? section.aiopsApprovalSecret,
            },
        };
    }
    // Fall back to top-level config (default account)
    if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
            accountId,
            name: section.name,
            enabled: section.enabled !== false,
            // websocket transport: a token is all that's needed
            configured: Boolean(section.token),
            token: section.token,
            config: {
                token: section.token ?? "",
                //default-deny (see setAccountEnabled note above).
                dmPolicy: section.dmPolicy ?? "deny",
                allowFrom: section.allowFrom,
                apiBaseUrl: section.apiBaseUrl,
                maxRetries: section.maxRetries,
                retryDelayMs: section.retryDelayMs,
                showProgressPlaceholder: section.showProgressPlaceholder,
                progressPlaceholderText: section.progressPlaceholderText,
                progressVerbosity: section.progressVerbosity,
                progressHeartbeatMs: section.progressHeartbeatMs,
                //agent binding for the default account.
                agent: section.agent,
                progressStreamReasoning: section.progressStreamReasoning,
                aiopsApprovalUrl: section.aiopsApprovalUrl,
                aiopsApprovalSecret: section.aiopsApprovalSecret,
            },
        };
    }
    // Account not found
    return {
        accountId,
        enabled: false,
        configured: false,
        config: {},
    };
}
const meta = {
    id: "webex",
    label: "Webex",
    selectionLabel: "Cisco Webex",
    docsPath: "/channels/webex",
    docsLabel: "webex",
    blurb: "Cisco Webex messaging via bot webhooks.",
    order: 75,
    aliases: ["cisco-webex"],
};
exports.webexPlugin = {
    id: "webex",
    meta,
    capabilities: {
        chatTypes: ["direct", "group"],
        threads: true,
        media: true,
    },
    reload: { configPrefixes: ["channels.webex"] },
    config: {
        listAccountIds: (cfg) => listWebexAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveWebexAccount({ cfg: cfg, accountId: accountId ?? undefined }),
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        setAccountEnabled: ({ cfg, accountId, enabled }) => {
            const config = cfg;
            const section = config.channels?.webex ?? {};
            if (accountId === DEFAULT_ACCOUNT_ID) {
                return {
                    ...config,
                    channels: {
                        ...config.channels,
                        webex: {
                            ...section,
                            enabled,
                        },
                    },
                };
            }
            return {
                ...config,
                channels: {
                    ...config.channels,
                    webex: {
                        ...section,
                        accounts: {
                            ...section.accounts,
                            [accountId]: {
                                ...section.accounts?.[accountId],
                                enabled,
                            },
                        },
                    },
                },
            };
        },
        deleteAccount: ({ cfg, accountId }) => {
            const config = cfg;
            const section = config.channels?.webex ?? {};
            if (accountId === DEFAULT_ACCOUNT_ID) {
                const { token, dmPolicy, allowFrom, ...rest } = section;
                return {
                    ...config,
                    channels: {
                        ...config.channels,
                        webex: rest,
                    },
                };
            }
            const accounts = { ...section.accounts };
            delete accounts[accountId];
            return {
                ...config,
                channels: {
                    ...config.channels,
                    webex: {
                        ...section,
                        accounts,
                    },
                },
            };
        },
        isConfigured: (account) => account.configured,
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
            baseUrl: account.config.apiBaseUrl ?? "https://webexapis.com/v1",
        }),
        resolveAllowFrom: ({ cfg }) => (cfg.channels?.webex?.allowFrom ?? []).map(String),
        formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry).trim().toLowerCase()),
    },
    security: {
        resolveDmPolicy: ({ account }) => {
            //default-deny.
            const policy = account.config.dmPolicy ?? "deny";
            // Map "allowlisted" to "allowlist" for OpenClaw compatibility
            const normalizedPolicy = policy === "allowlisted" ? "allowlist" : policy;
            return {
                policy: normalizedPolicy,
                allowFrom: account.config.allowFrom ?? [],
                policyPath: "channels.webex.dmPolicy",
                allowFromPath: "channels.webex.allowFrom",
                approveHint: "Add user ID or email to channels.webex.allowFrom",
                normalizeEntry: (raw) => raw.trim().toLowerCase(),
            };
        },
    },
    threading: {
        resolveReplyToMode: () => "off",
        buildToolContext: ({ context, hasRepliedRef }) => ({
            currentChannelId: context.To?.trim() || undefined,
            currentThreadTs: context.MessageThreadId != null
                ? String(context.MessageThreadId)
                : context.ReplyToId,
            hasRepliedRef,
        }),
    },
    messaging: {
        normalizeTarget: (raw) => {
            let normalized = raw.trim();
            if (!normalized)
                return undefined;
            if (normalized.toLowerCase().startsWith("webex:")) {
                normalized = normalized.slice("webex:".length).trim();
            }
            return normalized || undefined;
        },
        targetResolver: {
            // Backport 2026-05-08: runtime now passes both the raw and normalized
            // forms; use normalized when present so a "webex:..." prefix is stripped
            // before pattern-matching, and fall back to raw for compatibility.
            looksLikeId: (raw, normalized) => {
                const check = (normalized || raw || "").trim();
                if (!check)
                    return false;
                // Webex IDs are base64-encoded and start with a specific prefix
                if (check.startsWith("Y2lzY29zcGFyazovL3"))
                    return true;
                // Also accept emails
                return check.includes("@");
            },
            hint: "<roomId|personId|email>",
        },
    },
    outbound: {
        deliveryMode: "direct",
        textChunkLimit: 7000, // Webex has a 7439 byte limit
        // Backport 2026-05-08: the OpenClaw runtime contract for sendText /
        // sendMedia changed — `ctx` no longer includes a pre-resolved `account`
        // object. Providers are expected to receive `{ cfg, accountId, ... }` and
        // resolve the account themselves via resolveWebexAccount(). The previous
        // shape (`ctx.account`) caused "Cannot read properties of undefined
        // (reading 'config')" when the runtime called these handlers.
        sendText: async (ctx) => {
            const { cfg, accountId, to, text, replyToId, threadId } = ctx;
            // Diagnostic: core routes some replies through this outbound path in
            // addition to dispatcherOptions.deliver — log so duplicate-delivery
            // reports can be traced to their source.
            console.log(`[webex:${accountId ?? "default"}] outbound sendText to=${String(to).slice(0, 24)}… len=${typeof text === "string" ? text.length : 0}`);
            const account = resolveWebexAccount({ cfg, accountId: accountId ?? undefined });
            if (!account?.configured) {
                throw new Error(`Webex account ${accountId ?? DEFAULT_ACCOUNT_ID} is not configured`);
            }
            const sender = new send_1.WebexSender(account.config);
            const result = await sender.send({
                to,
                content: { text },
                parentId: replyToId ?? (threadId != null ? String(threadId) : undefined),
            });
            return {
                channel: "webex",
                messageId: result.id,
                roomId: result.roomId,
            };
        },
        sendMedia: async (ctx) => {
            const { cfg, accountId, to, text, mediaUrl, replyToId, threadId } = ctx;
            const account = resolveWebexAccount({ cfg, accountId: accountId ?? undefined });
            if (!account?.configured) {
                throw new Error(`Webex account ${accountId ?? DEFAULT_ACCOUNT_ID} is not configured`);
            }
            const sender = new send_1.WebexSender(account.config);
            const result = await sender.send({
                to,
                content: {
                    text,
                    files: mediaUrl ? [mediaUrl] : undefined,
                },
                parentId: replyToId ?? (threadId != null ? String(threadId) : undefined),
            });
            return {
                channel: "webex",
                messageId: result.id,
                roomId: result.roomId,
            };
        },
    },
    status: {
        defaultRuntime: {
            accountId: DEFAULT_ACCOUNT_ID,
            running: false,
            lastStartAt: null,
            lastStopAt: null,
            lastError: null,
        },
        collectStatusIssues: (accounts) => accounts.flatMap((account) => {
            const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
            if (!lastError)
                return [];
            return [
                {
                    channel: "webex",
                    accountId: account.accountId,
                    kind: "runtime",
                    message: `Channel error: ${lastError}`,
                },
            ];
        }),
        buildChannelSummary: ({ snapshot }) => ({
            configured: (snapshot.configured ?? false),
            baseUrl: (snapshot.baseUrl ?? null),
            running: (snapshot.running ?? false),
            lastStartAt: (snapshot.lastStartAt ?? null),
            lastStopAt: (snapshot.lastStopAt ?? null),
            lastError: (snapshot.lastError ?? null),
        }),
        probeAccount: async ({ account, timeoutMs }) => {
            if (!account.configured) {
                return {
                    ok: false,
                    error: "Account not configured",
                    elapsedMs: 0,
                };
            }
            const start = Date.now();
            try {
                const response = await fetch(`${account.config.apiBaseUrl ?? "https://webexapis.com/v1"}/people/me`, {
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${account.config.token}`,
                        "Content-Type": "application/json",
                    },
                    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
                });
                const elapsedMs = Date.now() - start;
                if (!response.ok) {
                    return {
                        ok: false,
                        error: `HTTP ${response.status}: ${response.statusText}`,
                        elapsedMs,
                    };
                }
                return { ok: true, elapsedMs };
            }
            catch (err) {
                return {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                    elapsedMs: Date.now() - start,
                };
            }
        },
        buildAccountSnapshot: ({ account, runtime, probe }) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
            baseUrl: account.config.apiBaseUrl ?? "https://webexapis.com/v1",
            running: runtime?.running ?? false,
            lastStartAt: runtime?.lastStartAt ?? null,
            lastStopAt: runtime?.lastStopAt ?? null,
            lastError: runtime?.lastError ?? null,
            probe,
            lastProbeAt: runtime?.lastProbeAt ?? null,
        }),
    },
    gateway: {
        /**
         * Keep the provider "alive" for the duration of the account's
         * lifetime by awaiting ctx.abortSignal before resolving.
         *
         *previously this returned an async
         * cleanup function immediately, which the OpenClaw SDK's runtime
         * interpreted as "provider has finished its work" — triggering
         * the auto-restart loop that spammed the log and leaked MCP
         * subprocesses on every cycle. A webhook-mode provider has no
         * event loop of its own (messages arrive via HTTP callbacks
         * handled by the gateway's webhook router) so we just park on
         * the abort signal and clean up when it fires.
         */
        startAccount: async (ctx) => {
            const { account, log, setStatus } = ctx;
            setStatus({
                accountId: account.accountId,
                baseUrl: account.config.apiBaseUrl ?? "https://webexapis.com/v1",
            });
            log?.info?.(`[${account.accountId}] starting Webex provider (websocket mode)`);
            const eventHandler = new webhook_1.WebexWebhookHandler(account.config);
            await eventHandler.initialize();
            const mercury = new websocket_1.WebexMercuryTransport(account.config, account.accountId, {
                onPayload: (payload) => {
                    void dispatchTransportPayload({
                        payload,
                        account,
                        webhookHandler: eventHandler,
                    }).catch((err) => {
                        console.error(`[webex:${account.accountId}] mercury dispatch failed: ${err instanceof Error ? err.message : err}`);
                    });
                },
                onLog: (level, msg) => {
                    (log?.[level] ?? console[level === "error" ? "error" : "log"])?.(msg);
                },
            });
            await mercury.start();
            log?.info?.(`[${account.accountId}] mercury websocket transport started (no inbound endpoint)`);
            const unregister = () => {
                void mercury.stop();
            };
            const abortSignal = ctx.abortSignal;
            if (abortSignal) {
                if (abortSignal.aborted) {
                    unregister();
                    log?.info?.(`[${account.accountId}] stopping Webex provider`);
                    return;
                }
                await new Promise((resolve) => {
                    abortSignal.addEventListener("abort", () => resolve(), {
                        once: true,
                    });
                });
                log?.info?.(`[${account.accountId}] stopping Webex provider`);
                unregister();
                return;
            }
            // No abort signal — fall back to returning a cleanup function
            // for SDK versions that still use that contract.
            return async () => {
                log?.info?.(`[${account.accountId}] stopping Webex provider`);
                unregister();
            };
        },
    },
};
//# sourceMappingURL=channel-plugin.js.map