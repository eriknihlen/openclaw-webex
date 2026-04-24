/**
 * Webex Webhook Handler Module
 */

import * as crypto from 'crypto';
import fetch from 'node-fetch';
import type {
  WebexChannelConfig,
  WebexWebhookPayload,
  WebexWebhookData,
  WebexMessage,
  WebexWebhook,
  CreateWebhookRequest,
  OpenClawEnvelope,
  OpenClawAttachment,
  PaginatedResponse,
} from './types';

const DEFAULT_API_BASE_URL = 'https://webexapis.com/v1';

export class WebexWebhookHandler {
  private config: WebexChannelConfig;
  private apiBaseUrl: string;
  private botId: string | null = null;

  constructor(config: WebexChannelConfig) {
    this.config = config;
    this.apiBaseUrl = config.apiBaseUrl || DEFAULT_API_BASE_URL;
  }

  /**
   * Initialize the webhook handler (fetch bot info)
   */
  async initialize(): Promise<void> {
    const botInfo = await this.getBotInfo();
    this.botId = botInfo.id;
  }

  /**
   * Handle an incoming webhook request
   */
  async handleWebhook(
    payload: WebexWebhookPayload,
    signature?: string
  ): Promise<OpenClawEnvelope | null> {
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
  verifySignature(payload: WebexWebhookPayload, signature: string): boolean {
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
  private isAllowedSender(data: WebexWebhookData): boolean {
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
  async handleAttachmentAction(
    payload: WebexWebhookPayload,
    signature?: string
  ): Promise<AttachmentActionEvent | null> {
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

    if (payload.resource !== 'attachmentActions') return null;
    if (payload.event !== 'created') return null;

    // Action submissions from the bot itself should never happen but
    // defend against loops.
    if (payload.data?.personId === this.botId) return null;

    const action = await this.fetchAttachmentAction(payload.data.id);
    if (!action) return null;

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
  private async fetchAttachmentAction(
    actionId: string
  ): Promise<AttachmentActionResponse | null> {
    const response = await fetch(
      `${this.apiBaseUrl}/attachment/actions/${actionId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Failed to fetch attachment action: ${response.status} ${response.statusText}`
      );
    }

    return response.json() as Promise<AttachmentActionResponse>;
  }

  /**
   * Fetch full message details from Webex API
   */
  private async fetchMessage(messageId: string): Promise<WebexMessage> {
    const response = await fetch(`${this.apiBaseUrl}/messages/${messageId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch message: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<WebexMessage>;
  }

  /**
   * Normalize a Webex message to OpenClaw envelope format
   */
  private normalizeMessage(message: WebexMessage): OpenClawEnvelope {
    const attachments: OpenClawAttachment[] = [];

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
  async registerWebhooks(): Promise<WebexWebhook[]> {
    const existing = await this.listWebhooks();
    const targetUrl = this.config.webhookUrl;

    const desired: Array<{
      name: string;
      resource: 'messages' | 'attachmentActions';
      event: 'created' | 'updated';
    }> = [
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

    const webhooks: WebexWebhook[] = [];
    const keepIds = new Set<string>();

    for (const d of desired) {
      const matches = existing.filter(
        (w) =>
          w.targetUrl === targetUrl &&
          w.resource === d.resource &&
          w.event === d.event
      );

      let primary: WebexWebhook;
      if (matches.length > 0) {
        primary = await this.updateWebhook(matches[0].id, {
          name: d.name,
          targetUrl,
          secret: this.config.webhookSecret,
          status: 'active',
        });
      } else {
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
        if (keepIds.has(extra.id)) continue;
        try {
          await this.deleteWebhook(extra.id);
        } catch {
          // swallow — duplicate will be cleaned up on a later restart
        }
      }
    }

    return webhooks;
  }

  /**
   * List all webhooks
   */
  async listWebhooks(): Promise<WebexWebhook[]> {
    const response = await fetch(`${this.apiBaseUrl}/webhooks`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list webhooks: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as PaginatedResponse<WebexWebhook>;
    return data.items;
  }

  /**
   * Create a webhook
   */
  async createWebhook(request: CreateWebhookRequest): Promise<WebexWebhook> {
    const response = await fetch(`${this.apiBaseUrl}/webhooks`, {
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

    return response.json() as Promise<WebexWebhook>;
  }

  /**
   * Update an existing webhook in place (PUT /webhooks/<id>).
   *
   *used by registerWebhooks() to refresh the
   * secret / name / status on a matching existing webhook rather than
   * burning a rate-limited DELETE+POST cycle.
   */
  async updateWebhook(
    webhookId: string,
    request: {
      name?: string;
      targetUrl?: string;
      secret?: string;
      status?: 'active' | 'inactive';
    }
  ): Promise<WebexWebhook> {
    const response = await fetch(`${this.apiBaseUrl}/webhooks/${webhookId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to update webhook: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return response.json() as Promise<WebexWebhook>;
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/webhooks/${webhookId}`, {
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
  private async getBotInfo(): Promise<{ id: string; displayName: string; emails: string[] }> {
    const response = await fetch(`${this.apiBaseUrl}/people/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get bot info: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<{ id: string; displayName: string; emails: string[] }>;
  }

  /**
   * Get the bot ID (after initialization)
   */
  getBotId(): string | null {
    return this.botId;
  }
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
 * Raw shape returned by GET /attachment-actions/{id}. Not exported —
 * the `AttachmentActionEvent` structure is the public contract.
 */
interface AttachmentActionResponse {
  id: string;
  type: string;
  messageId: string;
  personId: string;
  roomId: string;
  created: string;
  inputs?: Record<string, unknown>;
}

/**
 * Custom error for webhook validation failures
 */
export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookValidationError';

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, WebhookValidationError);
    }
  }
}
