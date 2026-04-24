"use strict";
/**
 * Webex Channel - Main Channel Logic
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebexChannel = void 0;
exports.createWebexChannel = createWebexChannel;
exports.createAndInitialize = createAndInitialize;
const send_1 = require("./send");
const webhook_1 = require("./webhook");
/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
    dmPolicy: 'allow',
    apiBaseUrl: 'https://webexapis.com/v1',
    maxRetries: 3,
    retryDelayMs: 1000,
};
/**
 * WebexChannel implements the OpenClaw channel plugin interface for Cisco Webex
 */
class WebexChannel {
    name = 'webex';
    version = '1.0.0';
    config = null;
    sender = null;
    webhookHandler = null;
    messageHandlers = [];
    initialized = false;
    /**
     * Initialize the channel with configuration
     */
    async initialize(config) {
        // Validate required config
        this.validateConfig(config);
        // Merge with defaults
        this.config = {
            ...DEFAULT_CONFIG,
            ...config,
        };
        // Initialize sender
        this.sender = new send_1.WebexSender(this.config);
        // Initialize webhook handler
        this.webhookHandler = new webhook_1.WebexWebhookHandler(this.config);
        await this.webhookHandler.initialize();
        this.initialized = true;
    }
    /**
     * Validate configuration
     */
    validateConfig(config) {
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
        }
        catch {
            throw new Error('Webex channel config webhookUrl must be a valid URL');
        }
    }
    /**
     * Ensure the channel is initialized
     */
    ensureInitialized() {
        if (!this.initialized || !this.config || !this.sender || !this.webhookHandler) {
            throw new Error('Webex channel is not initialized. Call initialize() first.');
        }
    }
    /**
     * Send a message
     */
    async send(message) {
        this.ensureInitialized();
        return this.sender.send(message);
    }
    /**
     * Send a simple text message to a room
     */
    async sendText(roomId, text) {
        return this.send({
            to: roomId,
            content: { text },
        });
    }
    /**
     * Send a markdown message to a room
     */
    async sendMarkdown(roomId, markdown) {
        return this.send({
            to: roomId,
            content: { markdown },
        });
    }
    /**
     * Send a direct message to a person
     */
    async sendDirect(personIdOrEmail, text) {
        return this.send({
            to: personIdOrEmail,
            content: { text },
        });
    }
    /**
     * Reply to a message in a thread
     */
    async reply(roomId, parentId, text) {
        return this.send({
            to: roomId,
            content: { text },
            parentId,
        });
    }
    /**
     * Handle incoming webhook
     */
    async handleWebhook(payload, signature) {
        this.ensureInitialized();
        const envelope = await this.webhookHandler.handleWebhook(payload, signature);
        if (envelope) {
            // Notify all registered handlers
            await this.notifyHandlers(envelope);
        }
        return envelope;
    }
    /**
     * Register a message handler
     */
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    /**
     * Remove a message handler
     */
    offMessage(handler) {
        const index = this.messageHandlers.indexOf(handler);
        if (index !== -1) {
            this.messageHandlers.splice(index, 1);
        }
    }
    /**
     * Notify all registered handlers of a new message
     */
    async notifyHandlers(envelope) {
        for (const handler of this.messageHandlers) {
            try {
                await handler(envelope);
            }
            catch (error) {
                console.error('Error in message handler:', error);
            }
        }
    }
    /**
     * Register webhooks with Webex
     */
    async registerWebhooks() {
        this.ensureInitialized();
        return this.webhookHandler.registerWebhooks();
    }
    /**
     * Get the sender instance for advanced operations
     */
    getSender() {
        this.ensureInitialized();
        return this.sender;
    }
    /**
     * Get the webhook handler instance for advanced operations
     */
    getWebhookHandler() {
        this.ensureInitialized();
        return this.webhookHandler;
    }
    /**
     * Get the current configuration
     */
    getConfig() {
        return this.config;
    }
    /**
     * Check if the channel is initialized
     */
    isInitialized() {
        return this.initialized;
    }
    /**
     * Cleanup and shutdown
     */
    async shutdown() {
        this.messageHandlers = [];
        this.sender = null;
        this.webhookHandler = null;
        this.config = null;
        this.initialized = false;
    }
}
exports.WebexChannel = WebexChannel;
/**
 * Create a new Webex channel instance
 */
function createWebexChannel() {
    return new WebexChannel();
}
/**
 * Create and initialize a Webex channel with config
 */
async function createAndInitialize(config) {
    const channel = createWebexChannel();
    await channel.initialize(config);
    return channel;
}
//# sourceMappingURL=channel.js.map