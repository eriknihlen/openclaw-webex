/**
 * Webex Channel - Main Channel Logic
 */

import type {
  WebexChannelConfig,
  WebexChannelPlugin,
  WebexMessage,
  WebexWebhook,
  WebexWebhookPayload,
  OpenClawEnvelope,
  OpenClawOutboundMessage,
  WebhookHandler,
} from './types';
import { WebexSender } from './send';
import { WebexWebhookHandler } from './webhook';

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Partial<WebexChannelConfig> = {
  dmPolicy: 'allow',
  apiBaseUrl: 'https://webexapis.com/v1',
  maxRetries: 3,
  retryDelayMs: 1000,
};

/**
 * WebexChannel implements the OpenClaw channel plugin interface for Cisco Webex
 */
export class WebexChannel implements WebexChannelPlugin {
  readonly name = 'webex';
  readonly version = '1.0.0';

  private config: WebexChannelConfig | null = null;
  private sender: WebexSender | null = null;
  private webhookHandler: WebexWebhookHandler | null = null;
  private messageHandlers: WebhookHandler[] = [];
  private initialized = false;

  /**
   * Initialize the channel with configuration
   */
  async initialize(config: WebexChannelConfig): Promise<void> {
    // Validate required config
    this.validateConfig(config);

    // Merge with defaults
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as WebexChannelConfig;

    // Initialize sender
    this.sender = new WebexSender(this.config);

    // Initialize webhook handler
    this.webhookHandler = new WebexWebhookHandler(this.config);
    await this.webhookHandler.initialize();

    this.initialized = true;
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: WebexChannelConfig): void {
    if (!config.token) {
      throw new Error('Webex channel config requires a token');
    }
    if (!config.webhookUrl) {
      throw new Error('Webex channel config requires a webhookUrl');
    }
    if (!config.dmPolicy) {
      throw new Error('Webex channel config requires a dmPolicy');
    }
    if (config.dmPolicy === 'allowlisted' && (!config.allowFrom || config.allowFrom.length === 0)) {
      throw new Error('Webex channel config requires allowFrom when dmPolicy is "allowlisted"');
    }

    // Validate webhook URL format
    try {
      new URL(config.webhookUrl);
    } catch {
      throw new Error('Webex channel config webhookUrl must be a valid URL');
    }
  }

  /**
   * Ensure the channel is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.config || !this.sender || !this.webhookHandler) {
      throw new Error('Webex channel is not initialized. Call initialize() first.');
    }
  }

  /**
   * Send a message
   */
  async send(message: OpenClawOutboundMessage): Promise<WebexMessage> {
    this.ensureInitialized();
    return this.sender!.send(message);
  }

  /**
   * Send a simple text message to a room
   */
  async sendText(roomId: string, text: string): Promise<WebexMessage> {
    return this.send({
      to: roomId,
      content: { text },
    });
  }

  /**
   * Send a markdown message to a room
   */
  async sendMarkdown(roomId: string, markdown: string): Promise<WebexMessage> {
    return this.send({
      to: roomId,
      content: { markdown },
    });
  }

  /**
   * Send a direct message to a person
   */
  async sendDirect(personIdOrEmail: string, text: string): Promise<WebexMessage> {
    return this.send({
      to: personIdOrEmail,
      content: { text },
    });
  }

  /**
   * Reply to a message in a thread
   */
  async reply(roomId: string, parentId: string, text: string): Promise<WebexMessage> {
    return this.send({
      to: roomId,
      content: { text },
      parentId,
    });
  }

  /**
   * Handle incoming webhook
   */
  async handleWebhook(
    payload: WebexWebhookPayload,
    signature?: string
  ): Promise<OpenClawEnvelope | null> {
    this.ensureInitialized();

    const envelope = await this.webhookHandler!.handleWebhook(payload, signature);

    if (envelope) {
      // Notify all registered handlers
      await this.notifyHandlers(envelope);
    }

    return envelope;
  }

  /**
   * Register a message handler
   */
  onMessage(handler: WebhookHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Remove a message handler
   */
  offMessage(handler: WebhookHandler): void {
    const index = this.messageHandlers.indexOf(handler);
    if (index !== -1) {
      this.messageHandlers.splice(index, 1);
    }
  }

  /**
   * Notify all registered handlers of a new message
   */
  private async notifyHandlers(envelope: OpenClawEnvelope): Promise<void> {
    for (const handler of this.messageHandlers) {
      try {
        await handler(envelope);
      } catch (error) {
        console.error('Error in message handler:', error);
      }
    }
  }

  /**
   * Register webhooks with Webex
   */
  async registerWebhooks(): Promise<WebexWebhook[]> {
    this.ensureInitialized();
    return this.webhookHandler!.registerWebhooks();
  }

  /**
   * Get the sender instance for advanced operations
   */
  getSender(): WebexSender {
    this.ensureInitialized();
    return this.sender!;
  }

  /**
   * Get the webhook handler instance for advanced operations
   */
  getWebhookHandler(): WebexWebhookHandler {
    this.ensureInitialized();
    return this.webhookHandler!;
  }

  /**
   * Get the current configuration
   */
  getConfig(): WebexChannelConfig | null {
    return this.config;
  }

  /**
   * Check if the channel is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Cleanup and shutdown
   */
  async shutdown(): Promise<void> {
    this.messageHandlers = [];
    this.sender = null;
    this.webhookHandler = null;
    this.config = null;
    this.initialized = false;
  }
}

/**
 * Create a new Webex channel instance
 */
export function createWebexChannel(): WebexChannel {
  return new WebexChannel();
}

/**
 * Create and initialize a Webex channel with config
 */
export async function createAndInitialize(config: WebexChannelConfig): Promise<WebexChannel> {
  const channel = createWebexChannel();
  await channel.initialize(config);
  return channel;
}
