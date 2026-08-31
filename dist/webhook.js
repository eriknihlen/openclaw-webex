"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebexWebhookHandler = void 0;
const node_fetch_1 = __importDefault(require("node-fetch"));
const DEFAULT_API_BASE_URL = 'https://webexapis.com/v1';
class WebexWebhookHandler {
    config;
    apiBaseUrl;
    botId = null;
    constructor(config) {
        this.config = config;
        this.apiBaseUrl = config.apiBaseUrl || DEFAULT_API_BASE_URL;
    }
    /**
     * Initialize the webhook handler (fetch bot info)
     */
    async initialize() {
        const botInfo = await this.getBotInfo();
        this.botId = botInfo.id;
    }
    /**
     * Handle an inbound message event payload.
     */
    async handleWebhook(payload) {
        // Only handle message events.upstream
        // accepted only `created`; we also accept `updated` (treat as new
        // message — the user has amended their question and probably wants
        // an answer to the new form) and `deleted` (drop silently — we
        // have no way to undo a reply the agent has already produced).
        if (payload.resource !== 'messages') {
            return null;
        }
        if (payload.event === 'deleted') {
            return null;
        }
        if (payload.event !== 'created' && payload.event !== 'updated') {
            return null;
        }
        // Ignore messages from the bot itself
        if (payload.data.personId === this.botId) {
            return null;
        }
        // Apply allowlist / DM policy to ALL room types (not just direct).
        // upstream only gated DMs, which left
        // group spaces open — anyone could add the bot to a space and @-mention
        // it. Now the allowlist applies uniformly across DMs and group spaces.
        if (!this.isAllowedSender(payload.data)) {
            return null;
        }
        // Fetch full message details (webhook only contains IDs)
        const message = await this.fetchMessage(payload.data.id);
        // Group spaces: require an @mention of the bot. Webex's webhook
        // delivery enforced this platform-side (bots only received mentioned
        // group messages), but the Mercury websocket transport delivers ALL
        // room activity — so without this gate the bot would answer every
        // allowlisted message in every space it's a member of. Re-impose the
        // platform's own etiquette: unmentioned group chatter is not for us.
        // DMs are unaffected.
        if (message.roomType === 'group' &&
            this.botId &&
            !(message.mentionedPeople ?? []).includes(this.botId)) {
            return null;
        }
        // Normalize to OpenClaw envelope
        return this.normalizeMessage(message);
    }
    /**
     * Check if the sender is allowed based on DM policy
     */
    isAllowedSender(data) {
        switch (this.config.dmPolicy) {
            case 'allow':
                return true;
            case 'deny':
                return false;
            case 'allowlisted':
                if (!this.config.allowFrom || this.config.allowFrom.length === 0) {
                    return false;
                }
                return this.config.allowFrom.includes(data.personId) ||
                    this.config.allowFrom.includes(data.personEmail);
            default:
                return false;
        }
    }
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
    async handleAttachmentAction(payload) {
        if (payload.resource !== 'attachmentActions')
            return null;
        if (payload.event !== 'created')
            return null;
        // Action submissions from the bot itself should never happen but
        // defend against loops.
        if (payload.data?.personId === this.botId)
            return null;
        const action = await this.fetchAttachmentAction(payload.data.id);
        if (!action)
            return null;
        return {
            id: action.id,
            type: action.type,
            messageId: action.messageId,
            personId: action.personId,
            roomId: action.roomId,
            created: action.created,
            inputs: action.inputs ?? {},
            // Webex merges card-embedded data into inputs; surface it
            // separately so callers can cleanly distinguish user inputs
            // from card routing metadata they themselves injected.
            data: typeof action.inputs === 'object' && action.inputs ? { ...action.inputs } : {},
        };
    }
    /**
     * GET /attachment-actions/{id}. Retrieves the inputs a user submitted
     * on an AdaptiveCard Action.Submit press, plus any `data` fields the
     * card author embedded on the action.
     */
    async fetchAttachmentAction(actionId) {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/attachment/actions/${actionId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
        });
        if (response.status === 404)
            return null;
        if (!response.ok) {
            throw new Error(`Failed to fetch attachment action: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }
    /**
     * Fetch full message details from Webex API
     */
    async fetchMessage(messageId) {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/messages/${messageId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch message: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }
    /**
     * Normalize a Webex message to OpenClaw envelope format
     */
    normalizeMessage(message) {
        const attachments = [];
        // Convert file attachments
        if (message.files && message.files.length > 0) {
            for (const fileUrl of message.files) {
                attachments.push({
                    type: 'file',
                    url: fileUrl,
                });
            }
        }
        // Convert card attachments
        if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
                attachments.push({
                    type: 'card',
                    content: attachment.content,
                });
            }
        }
        return {
            id: message.id,
            channel: 'webex',
            conversationId: message.roomId,
            author: {
                id: message.personId,
                email: message.personEmail,
                displayName: undefined, // Would need additional API call to get
                isBot: false, // Messages from bot are filtered out earlier
            },
            content: {
                text: message.text,
                markdown: message.markdown,
                attachments: attachments.length > 0 ? attachments : undefined,
            },
            metadata: {
                roomType: message.roomType,
                roomId: message.roomId,
                timestamp: message.created,
                mentions: message.mentionedPeople,
                parentId: message.parentId,
                raw: message,
            },
        };
    }
    /**
     * Get bot information
     */
    async getBotInfo() {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/people/me`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to get bot info: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }
    /**
     * Get the bot ID (after initialization)
     */
    getBotId() {
        return this.botId;
    }
}
exports.WebexWebhookHandler = WebexWebhookHandler;
//# sourceMappingURL=webhook.js.map