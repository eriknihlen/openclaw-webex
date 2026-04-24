"use strict";
/**
 * OpenClaw Channel Plugin for Webex
 *
 * Implements the ChannelPlugin interface for OpenClaw's plugin system.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.webexPlugin = void 0;
exports.setPluginRuntime = setPluginRuntime;
exports.registerWebexWebhookTarget = registerWebexWebhookTarget;
exports.createWebhookHandler = createWebhookHandler;
const send_1 = require("./send");
const webhook_1 = require("./webhook");
const download_1 = require("./download");
const progress_1 = require("./progress");
const people_cache_1 = require("./people-cache");
const formatters_1 = require("./formatters");
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
const webhookTargets = new Map();
function normalizeWebhookPath(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return "/";
    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    if (withSlash.length > 1 && withSlash.endsWith("/")) {
        return withSlash.slice(0, -1);
    }
    return withSlash;
}
function registerWebexWebhookTarget(path, target) {
    const key = normalizeWebhookPath(path);
    webhookTargets.set(key, target);
    return () => {
        webhookTargets.delete(key);
    };
}
async function readJsonBody(req, maxBytes) {
    const chunks = [];
    let total = 0;
    return await new Promise((resolve) => {
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                resolve({ ok: false, error: "payload too large" });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                const body = Buffer.concat(chunks).toString("utf-8");
                const parsed = JSON.parse(body);
                resolve({ ok: true, value: parsed });
            }
            catch {
                resolve({ ok: false, error: "invalid json" });
            }
        });
        req.on("error", (err) => {
            resolve({ ok: false, error: err.message });
        });
    });
}
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
    const showPlaceholder = account.config.showProgressPlaceholder !== false && verbosity !== "silent";
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
        await dispatchReply({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
                deliver: async (payload) => {
                    if (payload.text) {
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
        });
        if (!replyDelivered)
            await postErrorMessage();
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
async function processAttachmentActionAsync(opts) {
    const { action, account, runtime } = opts;
    const cfg = runtime.config?.loadConfig?.() ?? {};
    const agentId = typeof account.config.agent === "string" && account.config.agent.length > 0
        ? account.config.agent
        : "main";
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
    const sender = new send_1.WebexSender(account.config);
    try {
        await dispatchReply({
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
        });
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
function createWebhookHandler() {
    return async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = normalizeWebhookPath(url.pathname);
        // Health probe — useful for ngrok/monitoring integrations.
        //Lists currently registered accounts so you
        // can see at a glance whether the plugin is wired up.
        if (path === "/webhooks/webex/healthz" && req.method === "GET") {
            const accounts = Array.from(webhookTargets.entries()).map(([webhookPath, t]) => ({
                accountId: t.account.accountId,
                agent: t.account.config.agent ?? "main",
                webhookPath,
                configured: t.account.configured,
                enabled: t.account.enabled,
            }));
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({
                status: "ok",
                channel: "webex",
                accountCount: accounts.length,
                accounts,
            }));
            return true;
        }
        // Check if path matches /webhooks/webex/*
        if (!path.startsWith("/webhooks/webex/")) {
            return false;
        }
        const target = webhookTargets.get(path);
        if (!target) {
            return false;
        }
        if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("Allow", "POST");
            res.end("Method Not Allowed");
            return true;
        }
        const body = await readJsonBody(req, 1024 * 1024);
        if (!body.ok) {
            res.statusCode = body.error === "payload too large" ? 413 : 400;
            res.end(body.error ?? "invalid payload");
            return true;
        }
        const { account, webhookHandler } = target;
        try {
            const signature = req.headers["x-spark-signature"];
            const payload = body.value;
            // Route by resource type: messages → inbound chat flow;
            // attachmentActions → card-button submissions (tier-3). Both
            // arrive at the same URL; Webex registers them as separate
            // webhooks but we disambiguate here.
            if (payload.resource === "attachmentActions") {
                const action = await webhookHandler.handleAttachmentAction(payload, signature);
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true }));
                if (action && pluginRuntime) {
                    void processAttachmentActionAsync({
                        action,
                        account,
                        runtime: pluginRuntime,
                    }).catch((err) => {
                        console.error(`[webex:${account.accountId}] background card-action dispatch failed: ${err instanceof Error ? err.message : err}`);
                    });
                }
                return true;
            }
            // Validate signature + normalise message envelope. This is the only
            // work that must happen before we ACK — if it throws, we want to
            // reject with 401/500 so Webex's observability reflects the truth.
            const envelope = await webhookHandler.handleWebhook(payload, signature);
            // ACK Webex immediately.upstream awaited the
            // full agent dispatch before returning 200, which meant any reply
            // taking >10s caused Webex to retry and we'd double-dispatch. All
            // downstream work now runs detached; errors surface as progress
            // messages in the chat, not as HTTP status codes back to Webex.
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            if (envelope && pluginRuntime) {
                // Intentionally NOT awaited — runs after we've ACKed Webex.
                void processEnvelopeAsync({
                    envelope,
                    account,
                    runtime: pluginRuntime,
                }).catch((err) => {
                    console.error(`[webex:${account.accountId}] background dispatch failed: ${err instanceof Error ? err.message : err}`);
                });
            }
            return true;
        }
        catch (err) {
            // Signature / header validation failures get 401; everything else
            // is an unexpected internal error and gets 500.
            if (err instanceof webhook_1.WebhookValidationError) {
                console.warn(`[webex:${account.accountId}] webhook rejected: ${err.message}`);
                res.statusCode = 401;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message }));
                return true;
            }
            console.error(`[webex:${account.accountId}] webhook error: ${err instanceof Error ? err.message : err}`);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Internal error" }));
            return true;
        }
    };
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
        const webhookUrl = namedAccount.webhookUrl ?? section.webhookUrl;
        return {
            accountId,
            name: namedAccount.name,
            enabled: namedAccount.enabled !== false,
            configured: Boolean(token && webhookUrl),
            token,
            webhookUrl,
            config: {
                token: token ?? "",
                webhookUrl: webhookUrl ?? "",
                webhookSecret: namedAccount.webhookSecret ?? section.webhookSecret,
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
            },
        };
    }
    // Fall back to top-level config (default account)
    if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
            accountId,
            name: section.name,
            enabled: section.enabled !== false,
            configured: Boolean(section.token && section.webhookUrl),
            token: section.token,
            webhookUrl: section.webhookUrl,
            config: {
                token: section.token ?? "",
                webhookUrl: section.webhookUrl ?? "",
                webhookSecret: section.webhookSecret,
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
                const { token, webhookUrl, webhookSecret, dmPolicy, allowFrom, ...rest } = section;
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
            looksLikeId: (raw) => {
                const trimmed = raw.trim();
                if (!trimmed)
                    return false;
                // Webex IDs are base64-encoded and start with a specific prefix
                if (trimmed.startsWith("Y2lzY29zcGFyazovL3"))
                    return true;
                // Also accept emails
                return trimmed.includes("@");
            },
            hint: "<roomId|personId|email>",
        },
    },
    outbound: {
        deliveryMode: "direct",
        textChunkLimit: 7000, // Webex has a 7439 byte limit
        sendText: async (ctx) => {
            const { to, text, account, replyToId } = ctx;
            const sender = new send_1.WebexSender(account.config);
            const result = await sender.send({
                to,
                content: { text },
                parentId: replyToId ?? undefined,
            });
            return {
                channel: "webex",
                messageId: result.id,
                roomId: result.roomId,
            };
        },
        sendMedia: async (ctx) => {
            const { to, text, mediaUrl, account, replyToId } = ctx;
            const sender = new send_1.WebexSender(account.config);
            const result = await sender.send({
                to,
                content: {
                    text,
                    files: mediaUrl ? [mediaUrl] : undefined,
                },
                parentId: replyToId ?? undefined,
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
            log?.info?.(`[${account.accountId}] starting Webex provider (webhook mode)`);
            const webhookHandler = new webhook_1.WebexWebhookHandler(account.config);
            await webhookHandler.initialize();
            try {
                await webhookHandler.registerWebhooks();
                log?.info?.(`[${account.accountId}] webhooks registered`);
            }
            catch (err) {
                log?.warn?.(`[${account.accountId}] failed to register webhooks: ${err instanceof Error ? err.message : err}`);
            }
            const webhookPath = `/webhooks/webex/${account.accountId}`;
            const unregister = registerWebexWebhookTarget(webhookPath, {
                account,
                config: account.config,
                webhookHandler,
            });
            log?.info?.(`[${account.accountId}] HTTP webhook handler registered at ${webhookPath}`);
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