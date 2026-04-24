"use strict";
/**
 * Webex Webhook Handler Module
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
exports.WebhookValidationError = exports.WebexWebhookHandler = void 0;
const crypto = __importStar(require("crypto"));
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
     * Handle an incoming webhook request
     */
    async handleWebhook(payload, signature) {
        // Verify webhook signature if a secret is configured.
        // hardening: if webhookSecret is set, the header
        // MUST be present — upstream's `&& signature` check let unsigned
        // requests through when the header was absent, which defeats the
        // purpose of the secret entirely.
        if (this.config.webhookSecret) {
            if (!signature) {
                throw new WebhookValidationError('Missing X-Spark-Signature header');
            }
            if (!this.verifySignature(payload, signature)) {
                throw new WebhookValidationError('Invalid webhook signature');
            }
        }
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
        // Normalize to OpenClaw envelope
        return this.normalizeMessage(message);
    }
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
    verifySignature(payload, signature) {
        if (!this.config.webhookSecret) {
            return true;
        }
        const hmac = crypto.createHmac('sha1', this.config.webhookSecret);
        hmac.update(JSON.stringify(payload));
        const expectedSignature = hmac.digest('hex');
        const provided = Buffer.from(signature);
        const expected = Buffer.from(expectedSignature);
        if (provided.length !== expected.length) {
            return false;
        }
        return crypto.timingSafeEqual(provided, expected);
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
    async handleAttachmentAction(payload, signature) {
        // Same signature verification as handleWebhook — an unsigned request
        // against a bot with a webhook secret must be rejected regardless of
        // which resource it carries.
        if (this.config.webhookSecret) {
            if (!signature) {
                throw new WebhookValidationError('Missing X-Spark-Signature header');
            }
            if (!this.verifySignature(payload, signature)) {
                throw new WebhookValidationError('Invalid webhook signature');
            }
        }
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
    async registerWebhooks() {
        const existing = await this.listWebhooks();
        const targetUrl = this.config.webhookUrl;
        const desired = [
            {
                name: 'OpenClaw Message Handler (created)',
                resource: 'messages',
                event: 'created',
            },
            {
                name: 'OpenClaw Message Handler (updated)',
                resource: 'messages',
                event: 'updated',
            },
            {
                name: 'OpenClaw Card Submissions',
                resource: 'attachmentActions',
                event: 'created',
            },
        ];
        const webhooks = [];
        const keepIds = new Set();
        for (const d of desired) {
            const matches = existing.filter((w) => w.targetUrl === targetUrl &&
                w.resource === d.resource &&
                w.event === d.event);
            let primary;
            if (matches.length > 0) {
                primary = await this.updateWebhook(matches[0].id, {
                    name: d.name,
                    targetUrl,
                    secret: this.config.webhookSecret,
                    status: 'active',
                });
            }
            else {
                primary = await this.createWebhook({
                    name: d.name,
                    targetUrl,
                    resource: d.resource,
                    event: d.event,
                    secret: this.config.webhookSecret,
                });
            }
            webhooks.push(primary);
            keepIds.add(primary.id);
            // Best-effort dedupe: try to remove extra rows for this
            // (targetUrl, resource, event) tuple, but do not fail
            // registration if the DELETE is rate-limited.
            for (const extra of matches.slice(1)) {
                if (keepIds.has(extra.id))
                    continue;
                try {
                    await this.deleteWebhook(extra.id);
                }
                catch {
                    // swallow — duplicate will be cleaned up on a later restart
                }
            }
        }
        return webhooks;
    }
    /**
     * List all webhooks
     */
    async listWebhooks() {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/webhooks`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to list webhooks: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data.items;
    }
    /**
     * Create a webhook
     */
    async createWebhook(request) {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/webhooks`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create webhook: ${response.status} ${response.statusText} - ${errorText}`);
        }
        return response.json();
    }
    /**
     * Update an existing webhook in place (PUT /webhooks/<id>).
     *
     *used by registerWebhooks() to refresh the
     * secret / name / status on a matching existing webhook rather than
     * burning a rate-limited DELETE+POST cycle.
     */
    async updateWebhook(webhookId, request) {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/webhooks/${webhookId}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update webhook: ${response.status} ${response.statusText} - ${errorText}`);
        }
        return response.json();
    }
    /**
     * Delete a webhook
     */
    async deleteWebhook(webhookId) {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/webhooks/${webhookId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
            },
        });
        if (!response.ok && response.status !== 404) {
            throw new Error(`Failed to delete webhook: ${response.status} ${response.statusText}`);
        }
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
/**
 * Custom error for webhook validation failures
 */
class WebhookValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WebhookValidationError';
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, WebhookValidationError);
        }
    }
}
exports.WebhookValidationError = WebhookValidationError;
//# sourceMappingURL=webhook.js.map