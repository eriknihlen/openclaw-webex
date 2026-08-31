/**
 * Webex Event Handler Module
 *
 * Validates, fetches, and normalizes inbound Webex events into OpenClaw
 * envelopes. Events arrive as webhook-shaped payloads synthesized by the
 * Mercury websocket transport (websocket.ts). The class name predates the
 * webhook-transport removal (2026-08-31); it is kept to avoid churn.
 *
 * There is no HTTP signature verification here — nothing inbound exists
 * to sign. Sender authorization is the allowlist/dmPolicy check, which is
 * transport-independent and enforced on every event.
 */
import type { WebexChannelConfig, WebexWebhookPayload, OpenClawEnvelope } from './types';
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
     * Handle an inbound message event payload.
     */
    handleWebhook(payload: WebexWebhookPayload): Promise<OpenClawEnvelope | null>;
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
    handleAttachmentAction(payload: WebexWebhookPayload): Promise<AttachmentActionEvent | null>;
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
