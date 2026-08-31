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

import fetch from 'node-fetch';
import type {
  WebexChannelConfig,
  WebexWebhookPayload,
  WebexWebhookData,
  WebexMessage,
  OpenClawEnvelope,
  OpenClawAttachment,
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
   * Handle an inbound message event payload.
   */
  async handleWebhook(
    payload: WebexWebhookPayload
  ): Promise<OpenClawEnvelope | null> {
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
    payload: WebexWebhookPayload
  ): Promise<AttachmentActionEvent | null> {
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
