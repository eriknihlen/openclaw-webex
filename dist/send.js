"use strict";
/**
 * Webex Message Sending Module
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebexApiRequestError = exports.WebexSender = void 0;
exports.resolveMessageTarget = resolveMessageTarget;
const node_fetch_1 = __importDefault(require("node-fetch"));
const fsp = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const DEFAULT_API_BASE_URL = 'https://webexapis.com/v1';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
// Webex's documented upload cap for message attachments.
const MAX_OUTBOUND_FILE_BYTES = 100 * 1024 * 1024;
// Small extension -> content-type map for sendLocalFile. Not exhaustive —
// Webex mostly just needs *a* reasonable type; unknown extensions fall
// back to application/octet-stream.
const CONTENT_TYPE_BY_EXTENSION = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/plain',
    '.csv': 'text/plain',
    '.json': 'text/plain',
    '.xml': 'text/plain',
    '.zip': 'application/zip',
    '.log': 'text/plain',
};
function inferOutboundContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return CONTENT_TYPE_BY_EXTENSION[ext] ?? 'application/octet-stream';
}
/**
 * Resolve an OpenClaw `to` string into the roomId/toPersonId/
 * toPersonEmail field Webex expects. Shared between buildMessageRequest
 * (the normal JSON send path) and channel-plugin.ts's sendMedia local-
 * file branch, so a local-file send targets the same kind of recipient
 * (room, person by id, or person by email) that a URL-based send would
 * for the same `to` value, instead of always assuming roomId.
 */
function resolveMessageTarget(to) {
    if (to.includes('@')) {
        return { toPersonEmail: to };
    }
    if (to.startsWith('Y2lzY29zcGFyazovL3')) {
        // Base64-encoded Webex IDs - decode to check type
        try {
            const decoded = Buffer.from(to, 'base64').toString('utf-8');
            if (decoded.includes('/ROOM/')) {
                return { roomId: to };
            }
            if (decoded.includes('/PEOPLE/')) {
                return { toPersonId: to };
            }
            // Default to roomId for other types
            return { roomId: to };
        }
        catch {
            // If decode fails, assume it's a roomId
            return { roomId: to };
        }
    }
    // Assume it's a roomId if not an email or a decodable Webex ID
    return { roomId: to };
}
// Webex bot rate limit is ~5 msg/sec per bot. 250ms between requests
// stays safely under 4 msg/sec, giving headroom for the occasional
// webhook/delete happening in parallel.
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250;
// Rate limit status codes that should trigger retry
const RETRY_STATUS_CODES = [429, 502, 503, 504];
class WebexSender {
    config;
    apiBaseUrl;
    retryOptions;
    minRequestIntervalMs;
    /**
     * Proactive rate-limit state. We serialise outbound requests through
     * a promise chain so each request waits its turn before firing,
     * avoiding 429s under bursty progress updates.
     */
    rateLimitChain = Promise.resolve();
    lastRequestAt = 0;
    constructor(config) {
        this.config = config;
        this.apiBaseUrl = config.apiBaseUrl || DEFAULT_API_BASE_URL;
        this.retryOptions = {
            maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
            retryDelayMs: config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
        };
        this.minRequestIntervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS;
    }
    /**
     * Acquire a rate-limit slot. Returns after enough time has elapsed
     * since the previous request to stay within the configured interval.
     * Callers chain onto the returned promise before making a request.
     */
    acquireSlot() {
        const next = this.rateLimitChain.then(async () => {
            const now = Date.now();
            const elapsed = now - this.lastRequestAt;
            const wait = this.minRequestIntervalMs - elapsed;
            if (wait > 0) {
                await new Promise((resolve) => setTimeout(resolve, wait));
            }
            this.lastRequestAt = Date.now();
        });
        // Keep the chain alive even if this promise rejects.
        this.rateLimitChain = next.catch(() => { });
        return next;
    }
    /**
     * Send a message to Webex
     */
    async send(message) {
        const request = this.buildMessageRequest(message);
        return this.createMessage(request);
    }
    /**
     * Send a text message to a room
     */
    async sendToRoom(roomId, text, markdown) {
        return this.createMessage({
            roomId,
            text,
            markdown,
        });
    }
    /**
     * Send a direct message to a person by ID
     */
    async sendDirectById(personId, text, markdown) {
        return this.createMessage({
            toPersonId: personId,
            text,
            markdown,
        });
    }
    /**
     * Send a direct message to a person by email
     */
    async sendDirectByEmail(email, text, markdown) {
        return this.createMessage({
            toPersonEmail: email,
            text,
            markdown,
        });
    }
    /**
     * Send a message with file attachment
     */
    async sendWithFile(roomId, text, fileUrl) {
        return this.createMessage({
            roomId,
            text,
            files: [fileUrl],
        });
    }
    /**
     * Send a message with a LOCAL file attached, via multipart/form-data
     * upload to POST /v1/messages. This is the only way to get a file the
     * agent produced on disk (a report, a rendered diagram) into Webex —
     * `send()`/`sendWithFile()` only ever hand Webex a URL it fetches
     * itself, which doesn't work for output that never had one.
     *
     * Callers MUST have already run `filePath` through
     * outbound-file-guard.ts's resolveAllowedOutboundFile — this method
     * trusts the path it's given and does not re-validate it against any
     * allowlist.
     *
     * Deliberately uses the Node/undici GLOBAL fetch + FormData + Blob
     * here instead of the module's `node-fetch` v2 import (used
     * everywhere else in this file): node-fetch v2 has no native
     * multipart support and would need the `form-data` package, which
     * this plugin doesn't depend on. `fetch` is shadowed to the
     * node-fetch import at module scope, so `globalThis.fetch` is used
     * explicitly to reach the real global implementation.
     */
    async sendLocalFile(opts) {
        const { roomId, toPersonId, toPersonEmail, filePath, text, markdown, parentId } = opts;
        if (!roomId && !toPersonId && !toPersonEmail) {
            throw new Error('sendLocalFile: message must have a target: roomId, toPersonId, or toPersonEmail');
        }
        // Open once and stat/read off the same file descriptor rather than
        // stat-by-path then read-by-path: the latter leaves a window (the
        // /tmp root in particular is world-writable) where the path could
        // be swapped between the two calls. A single fd pins us to whatever
        // inode we opened.
        const fh = await fsp.open(filePath, 'r');
        let buffer;
        try {
            const stat = await fh.stat();
            // A FIFO would hang readFile indefinitely — well past the fetch
            // timeout below — and a directory throws a confusing EISDIR from
            // readFile; reject both explicitly with a clear local error.
            if (!stat.isFile()) {
                throw new Error(`sendLocalFile: "${filePath}" is not a regular file`);
            }
            if (stat.size > MAX_OUTBOUND_FILE_BYTES) {
                throw new Error(`sendLocalFile: "${filePath}" is ${stat.size} bytes, exceeding the ${MAX_OUTBOUND_FILE_BYTES}-byte (100 MB) Webex upload cap`);
            }
            buffer = await fh.readFile();
        }
        finally {
            await fh.close();
        }
        const filename = path.basename(filePath);
        const contentType = inferOutboundContentType(filename);
        const form = new FormData();
        if (roomId)
            form.append('roomId', roomId);
        if (toPersonId)
            form.append('toPersonId', toPersonId);
        if (toPersonEmail)
            form.append('toPersonEmail', toPersonEmail);
        if (text)
            form.append('text', text);
        if (markdown)
            form.append('markdown', markdown);
        if (parentId)
            form.append('parentId', parentId);
        form.append('files', new Blob([buffer], { type: contentType }), filename);
        await this.acquireSlot();
        const response = await globalThis.fetch(`${this.apiBaseUrl}/messages`, {
            method: 'POST',
            headers: {
                // Deliberately NOT setting Content-Type: FormData computes the
                // multipart boundary itself and sets the header to match: an
                // explicit Content-Type here would omit/mismatch the boundary
                // and Webex would fail to parse the body.
                Authorization: `Bearer ${this.config.token}`,
            },
            body: form,
            signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
            // Never surface the response body here — it can echo back
            // request content; status + statusText is enough to diagnose.
            throw new Error(`sendLocalFile: Webex upload failed: HTTP ${response.status} ${response.statusText}`);
        }
        return (await response.json());
    }
    /**
     * Send a threaded reply
     */
    async sendReply(roomId, parentId, text, markdown) {
        return this.createMessage({
            roomId,
            parentId,
            text,
            markdown,
        });
    }
    /**
     * Get a message by ID. `opts.maxRetries` lets a latency-sensitive caller
     * (e.g. a best-effort pre-dispatch check) cap the retry budget below the
     * sender's configured default, instead of inheriting the full
     * retry/backoff chain meant for outbound message delivery.
     */
    async getMessage(messageId, opts) {
        return this.request({
            method: 'GET',
            path: `/messages/${messageId}`,
            maxRetries: opts?.maxRetries,
        });
    }
    /**
     * Edit an existing message in place via PUT /messages/{id}.
     *
     * Webex caps edits at 10 per message. The request body requires
     * `roomId` plus either `text` or `markdown` (Webex rejects requests
     * with an `html` field when editing a markdown message — we never
     * set html anywhere, so this is not a concern).
     *
     * Used by the progress reporter to refresh a single "working…" line
     * for the first N transitions instead of spamming the chat with one
     * message per state change.
     */
    async updateMessage(messageId, roomId, text, markdown) {
        const body = { roomId, text };
        if (markdown)
            body.markdown = markdown;
        return this.request({
            method: 'PUT',
            path: `/messages/${messageId}`,
            body,
        });
    }
    /**
     * Edit an existing message into a card-carrying state via PUT
     * /messages/{id}. Sibling to updateMessage — that method only ever
     * carries text/markdown; card edits need the `attachments` array too,
     * and Webex requires `roomId` in the body either way. Used by the
     * card-rewrite flow (channel-plugin.ts rewriteSourceCardAsUsed) to
     * replace an interactive card with its deadened "used" form after a
     * button click, so the original message becomes a read-only outcome
     * record instead of staying tappable.
     *
     * `text` is required — Webex's PUT rejects an edit with neither text
     * nor markdown, and every rewrite has a summary line to show. Capped
     * at 7000 chars here as a last line of defense even though callers
     * are expected to cap it themselves (e.g. preserving the original
     * message's text alongside the appended summary).
     */
    async updateCardMessage(messageId, opts) {
        const body = {
            roomId: opts.roomId,
            text: opts.text.slice(0, 7000),
        };
        if (opts.markdown)
            body.markdown = opts.markdown;
        body.attachments = [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: opts.card,
            },
        ];
        return this.request({
            method: 'PUT',
            path: `/messages/${messageId}`,
            body,
        });
    }
    /**
     * Delete a message by ID
     */
    async deleteMessage(messageId) {
        await this.request({
            method: 'DELETE',
            path: `/messages/${messageId}`,
        });
    }
    /**
     * Build a Webex message request from an OpenClaw outbound message
     */
    buildMessageRequest(message) {
        const request = {
            ...resolveMessageTarget(message.to),
        };
        // Set content.
        //
        // Webex renders only the `markdown` field as formatted markdown; the `text`
        // field is shown verbatim as plaintext fallback for clients that don't
        // support markdown. OpenClaw agents emit markdown-formatted text via the
        // `text` payload field, so when no explicit `markdown` is supplied we
        // duplicate the text there so it renders correctly in Webex.
        if (message.content.text) {
            request.text = message.content.text;
        }
        if (message.content.markdown) {
            request.markdown = message.content.markdown;
        }
        else if (message.content.text) {
            request.markdown = message.content.text;
        }
        if (message.content.files && message.content.files.length > 0) {
            // Webex only allows one file per message
            request.files = [message.content.files[0]];
        }
        if (message.content.card) {
            request.attachments = [
                {
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    content: message.content.card,
                },
            ];
        }
        // Set threading
        if (message.parentId) {
            request.parentId = message.parentId;
        }
        return request;
    }
    /**
     * Create a message via the Webex API
     */
    async createMessage(request) {
        this.validateMessageRequest(request);
        return this.request({
            method: 'POST',
            path: '/messages',
            body: request,
        });
    }
    /**
     * Validate a message request before sending
     */
    validateMessageRequest(request) {
        // Must have a target
        if (!request.roomId && !request.toPersonId && !request.toPersonEmail) {
            throw new Error('Message must have a target: roomId, toPersonId, or toPersonEmail');
        }
        // Must have content
        if (!request.text && !request.markdown && !request.files?.length && !request.attachments?.length) {
            throw new Error('Message must have content: text, markdown, files, or attachments');
        }
        // Text has a max size of 7439 bytes
        if (request.text && Buffer.byteLength(request.text, 'utf8') > 7439) {
            throw new Error('Message text exceeds maximum size of 7439 bytes');
        }
    }
    /**
     * Make an API request with retry logic
     */
    async request(options) {
        let lastError = null;
        let attempt = 0;
        const maxRetries = options.maxRetries ?? this.retryOptions.maxRetries;
        while (attempt <= maxRetries) {
            try {
                await this.acquireSlot();
                return await this.executeRequest(options);
            }
            catch (error) {
                lastError = error;
                attempt++;
                if (attempt > maxRetries) {
                    break;
                }
                if (!this.shouldRetry(error, attempt)) {
                    break;
                }
                // Exponential backoff with jitter
                const delay = this.calculateBackoff(attempt);
                await this.sleep(delay);
            }
        }
        throw lastError || new Error('Request failed after retries');
    }
    /**
     * Execute a single API request
     */
    async executeRequest(options) {
        const url = `${this.apiBaseUrl}${options.path}`;
        const headers = {
            'Authorization': `Bearer ${this.config.token}`,
            'Content-Type': 'application/json',
            ...options.headers,
        };
        const response = await (0, node_fetch_1.default)(url, {
            method: options.method,
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        if (!response.ok) {
            const error = await this.parseErrorResponse(response);
            throw error;
        }
        // DELETE requests return 204 No Content
        if (response.status === 204) {
            return undefined;
        }
        return response.json();
    }
    /**
     * Parse error response from Webex API
     */
    async parseErrorResponse(response) {
        let errorData = null;
        try {
            errorData = await response.json();
        }
        catch {
            // Response body might not be JSON
        }
        const message = errorData?.message || `HTTP ${response.status}: ${response.statusText}`;
        const error = new WebexApiRequestError(message, response.status, errorData?.trackingId, errorData?.errors);
        return error;
    }
    /**
     * Determine if a request should be retried
     */
    shouldRetry(error, attempt) {
        if (error instanceof WebexApiRequestError) {
            return RETRY_STATUS_CODES.includes(error.statusCode);
        }
        // Retry network errors
        return error.message.includes('ECONNRESET') ||
            error.message.includes('ETIMEDOUT') ||
            error.message.includes('ENOTFOUND');
    }
    /**
     * Calculate backoff delay with exponential backoff and jitter
     */
    calculateBackoff(attempt) {
        const baseDelay = this.retryOptions.retryDelayMs;
        const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 0.3 * exponentialDelay;
        return Math.min(exponentialDelay + jitter, 30000); // Cap at 30 seconds
    }
    /**
     * Sleep for a given number of milliseconds
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.WebexSender = WebexSender;
/**
 * Custom error class for Webex API errors
 */
class WebexApiRequestError extends Error {
    statusCode;
    trackingId;
    details;
    constructor(message, statusCode, trackingId, details) {
        super(message);
        this.name = 'WebexApiRequestError';
        this.statusCode = statusCode;
        this.trackingId = trackingId;
        this.details = details;
        // Maintains proper stack trace for where error was thrown
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, WebexApiRequestError);
        }
    }
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            statusCode: this.statusCode,
            trackingId: this.trackingId,
            details: this.details,
        };
    }
}
exports.WebexApiRequestError = WebexApiRequestError;
//# sourceMappingURL=send.js.map