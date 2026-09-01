/**
 * Webex Message Sending Module
 */
import type { WebexChannelConfig, WebexMessage, OpenClawOutboundMessage, AdaptiveCard } from './types';
/**
 * Resolve an OpenClaw `to` string into the roomId/toPersonId/
 * toPersonEmail field Webex expects. Shared between buildMessageRequest
 * (the normal JSON send path) and channel-plugin.ts's sendMedia local-
 * file branch, so a local-file send targets the same kind of recipient
 * (room, person by id, or person by email) that a URL-based send would
 * for the same `to` value, instead of always assuming roomId.
 */
export declare function resolveMessageTarget(to: string): {
    roomId?: string;
    toPersonId?: string;
    toPersonEmail?: string;
};
export declare class WebexSender {
    private config;
    private apiBaseUrl;
    private retryOptions;
    private minRequestIntervalMs;
    /**
     * Proactive rate-limit state. We serialise outbound requests through
     * a promise chain so each request waits its turn before firing,
     * avoiding 429s under bursty progress updates.
     */
    private rateLimitChain;
    private lastRequestAt;
    constructor(config: WebexChannelConfig);
    /**
     * Acquire a rate-limit slot. Returns after enough time has elapsed
     * since the previous request to stay within the configured interval.
     * Callers chain onto the returned promise before making a request.
     */
    private acquireSlot;
    /**
     * Send a message to Webex
     */
    send(message: OpenClawOutboundMessage): Promise<WebexMessage>;
    /**
     * Send a text message to a room
     */
    sendToRoom(roomId: string, text: string, markdown?: string): Promise<WebexMessage>;
    /**
     * Send a direct message to a person by ID
     */
    sendDirectById(personId: string, text: string, markdown?: string): Promise<WebexMessage>;
    /**
     * Send a direct message to a person by email
     */
    sendDirectByEmail(email: string, text: string, markdown?: string): Promise<WebexMessage>;
    /**
     * Send a message with file attachment
     */
    sendWithFile(roomId: string, text: string, fileUrl: string): Promise<WebexMessage>;
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
    sendLocalFile(opts: {
        roomId?: string;
        toPersonId?: string;
        toPersonEmail?: string;
        filePath: string;
        text?: string;
        markdown?: string;
        parentId?: string;
    }): Promise<WebexMessage>;
    /**
     * Send a threaded reply
     */
    sendReply(roomId: string, parentId: string, text: string, markdown?: string): Promise<WebexMessage>;
    /**
     * Get a message by ID. `opts.maxRetries` lets a latency-sensitive caller
     * (e.g. a best-effort pre-dispatch check) cap the retry budget below the
     * sender's configured default, instead of inheriting the full
     * retry/backoff chain meant for outbound message delivery.
     */
    getMessage(messageId: string, opts?: {
        maxRetries?: number;
    }): Promise<WebexMessage>;
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
    updateMessage(messageId: string, roomId: string, text: string, markdown?: string): Promise<WebexMessage>;
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
    updateCardMessage(messageId: string, opts: {
        roomId: string;
        text: string;
        markdown?: string;
        card: AdaptiveCard;
    }): Promise<WebexMessage>;
    /**
     * Delete a message by ID
     */
    deleteMessage(messageId: string): Promise<void>;
    /**
     * Build a Webex message request from an OpenClaw outbound message
     */
    private buildMessageRequest;
    /**
     * Create a message via the Webex API
     */
    private createMessage;
    /**
     * Validate a message request before sending
     */
    private validateMessageRequest;
    /**
     * Make an API request with retry logic
     */
    private request;
    /**
     * Execute a single API request
     */
    private executeRequest;
    /**
     * Parse error response from Webex API
     */
    private parseErrorResponse;
    /**
     * Determine if a request should be retried
     */
    private shouldRetry;
    /**
     * Calculate backoff delay with exponential backoff and jitter
     */
    private calculateBackoff;
    /**
     * Sleep for a given number of milliseconds
     */
    private sleep;
}
/**
 * Custom error class for Webex API errors
 */
export declare class WebexApiRequestError extends Error {
    readonly statusCode: number;
    readonly trackingId?: string;
    readonly details?: Array<{
        description: string;
    }>;
    constructor(message: string, statusCode: number, trackingId?: string, details?: Array<{
        description: string;
    }>);
    toJSON(): object;
}
