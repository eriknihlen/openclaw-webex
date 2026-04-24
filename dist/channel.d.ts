/**
 * Webex Channel - Main Channel Logic
 */
import type { WebexChannelConfig, WebexChannelPlugin, WebexMessage, WebexWebhook, WebexWebhookPayload, OpenClawEnvelope, OpenClawOutboundMessage, WebhookHandler } from './types';
import { WebexSender } from './send';
import { WebexWebhookHandler } from './webhook';
/**
 * WebexChannel implements the OpenClaw channel plugin interface for Cisco Webex
 */
export declare class WebexChannel implements WebexChannelPlugin {
    readonly name = "webex";
    readonly version = "1.0.0";
    private config;
    private sender;
    private webhookHandler;
    private messageHandlers;
    private initialized;
    /**
     * Initialize the channel with configuration
     */
    initialize(config: WebexChannelConfig): Promise<void>;
    /**
     * Validate configuration
     */
    private validateConfig;
    /**
     * Ensure the channel is initialized
     */
    private ensureInitialized;
    /**
     * Send a message
     */
    send(message: OpenClawOutboundMessage): Promise<WebexMessage>;
    /**
     * Send a simple text message to a room
     */
    sendText(roomId: string, text: string): Promise<WebexMessage>;
    /**
     * Send a markdown message to a room
     */
    sendMarkdown(roomId: string, markdown: string): Promise<WebexMessage>;
    /**
     * Send a direct message to a person
     */
    sendDirect(personIdOrEmail: string, text: string): Promise<WebexMessage>;
    /**
     * Reply to a message in a thread
     */
    reply(roomId: string, parentId: string, text: string): Promise<WebexMessage>;
    /**
     * Handle incoming webhook
     */
    handleWebhook(payload: WebexWebhookPayload, signature?: string): Promise<OpenClawEnvelope | null>;
    /**
     * Register a message handler
     */
    onMessage(handler: WebhookHandler): void;
    /**
     * Remove a message handler
     */
    offMessage(handler: WebhookHandler): void;
    /**
     * Notify all registered handlers of a new message
     */
    private notifyHandlers;
    /**
     * Register webhooks with Webex
     */
    registerWebhooks(): Promise<WebexWebhook[]>;
    /**
     * Get the sender instance for advanced operations
     */
    getSender(): WebexSender;
    /**
     * Get the webhook handler instance for advanced operations
     */
    getWebhookHandler(): WebexWebhookHandler;
    /**
     * Get the current configuration
     */
    getConfig(): WebexChannelConfig | null;
    /**
     * Check if the channel is initialized
     */
    isInitialized(): boolean;
    /**
     * Cleanup and shutdown
     */
    shutdown(): Promise<void>;
}
/**
 * Create a new Webex channel instance
 */
export declare function createWebexChannel(): WebexChannel;
/**
 * Create and initialize a Webex channel with config
 */
export declare function createAndInitialize(config: WebexChannelConfig): Promise<WebexChannel>;
