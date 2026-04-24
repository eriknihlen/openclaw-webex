/**
 * Webex Message Sending Module
 */
import type { WebexChannelConfig, WebexMessage, OpenClawOutboundMessage } from './types';
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
     * Send a threaded reply
     */
    sendReply(roomId: string, parentId: string, text: string, markdown?: string): Promise<WebexMessage>;
    /**
     * Get a message by ID
     */
    getMessage(messageId: string): Promise<WebexMessage>;
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
