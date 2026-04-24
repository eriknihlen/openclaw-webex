/**
 * Webex Webhook Handler Module
 */
import type { WebexChannelConfig, WebexWebhookPayload, WebexWebhook, CreateWebhookRequest, OpenClawEnvelope } from './types';
export declare class WebexWebhookHandler {
    private config;
    private apiBaseUrl;
    private botId;
    constructor(config: WebexChannelConfig);
    /**
     * Initialize the webhook handler (fetch bot info)
     */
    initialize(): Promise<void>;
    /**
     * Handle an incoming webhook request
     */
    handleWebhook(payload: WebexWebhookPayload, signature?: string): Promise<OpenClawEnvelope | null>;
    /**
     * Verify webhook signature using HMAC-SHA1.
     *
     * Callers are expected to have already rejected requests without a
     * signature header when a webhookSecret is configured; this function
     * only validates the signature bytes themselves.
     *
     * hardening: length-check the buffers before
     * calling `timingSafeEqual`, which throws on mismatched lengths.
     * Previously a short/malformed signature would surface as HTTP 500
     * instead of 401.
     */
    verifySignature(payload: WebexWebhookPayload, signature: string): boolean;
    /**
     * Check if the sender is allowed based on DM policy
     */
    private isAllowedSender;
    /**
     * Handle an incoming `attachmentActions` webhook. The webhook payload
     * only carries the action id; we must GET the action to retrieve the
     * user's submitted inputs plus the `data` blob we embedded on the
     * card's Action.Submit.
     *
     * Returns a structured event the caller can dispatch, or null if the
     * payload isn't an attachmentActions/created event we care about.
     *
     */
    handleAttachmentAction(payload: WebexWebhookPayload, signature?: string): Promise<AttachmentActionEvent | null>;
    /**
     * GET /attachment-actions/{id}. Retrieves the inputs a user submitted
     * on an AdaptiveCard Action.Submit press, plus any `data` fields the
     * card author embedded on the action.
     */
    private fetchAttachmentAction;
    /**
     * Fetch full message details from Webex API
     */
    private fetchMessage;
    /**
     * Normalize a Webex message to OpenClaw envelope format
     */
    private normalizeMessage;
    /**
     * Register webhooks with Webex.
     *
     *PUT-in-place pattern.
     *
     * Webex's `/webhooks` DELETE endpoint is heavily rate-limited (we've
     * observed 429 with Retry-After up to 755s). The previous
     * delete-then-create pattern made startup brittle: any transient 429
     * on the delete crashed registration, the provider auto-restarted,
     * ran DELETE again, got throttled harder, and locked us out for
     * minutes-to-an-hour at a time.
     *
     * Instead:
     *   - for each (resource, event) we want, find the first existing
     *     webhook with the same targetUrl and PUT to refresh its secret
     *     / name / status. PUT is not rate-limited the same way.
     *   - create fresh via POST only if nothing matches.
     *   - best-effort DELETE any extra duplicates, but swallow 429s —
     *     we can tolerate leftover inactive webhooks for a while, we
     *     cannot tolerate the bot being unable to start.
     *
     *also registers an
     * `attachmentActions/created` webhook so AdaptiveCard button
     * submissions reach the same endpoint. Webex posts both resources
     * to the same URL; resource-type routing happens in handleWebhook.
     */
    registerWebhooks(): Promise<WebexWebhook[]>;
    /**
     * List all webhooks
     */
    listWebhooks(): Promise<WebexWebhook[]>;
    /**
     * Create a webhook
     */
    createWebhook(request: CreateWebhookRequest): Promise<WebexWebhook>;
    /**
     * Update an existing webhook in place (PUT /webhooks/<id>).
     *
     *used by registerWebhooks() to refresh the
     * secret / name / status on a matching existing webhook rather than
     * burning a rate-limited DELETE+POST cycle.
     */
    updateWebhook(webhookId: string, request: {
        name?: string;
        targetUrl?: string;
        secret?: string;
        status?: 'active' | 'inactive';
    }): Promise<WebexWebhook>;
    /**
     * Delete a webhook
     */
    deleteWebhook(webhookId: string): Promise<void>;
    /**
     * Get bot information
     */
    private getBotInfo;
    /**
     * Get the bot ID (after initialization)
     */
    getBotId(): string | null;
}
/**
 * Normalised attachment-action event returned by handleAttachmentAction.
 * Callers dispatch these back into the agent as synthesized messages.
 */
export interface AttachmentActionEvent {
    id: string;
    type: string;
    messageId: string;
    personId: string;
    roomId: string;
    created: string;
    /** Raw inputs submitted by the user (form fields + embedded `data`). */
    inputs: Record<string, unknown>;
    /** Alias for inputs, kept for future divergence. */
    data: Record<string, unknown>;
}
/**
 * Custom error for webhook validation failures
 */
export declare class WebhookValidationError extends Error {
    constructor(message: string);
}
