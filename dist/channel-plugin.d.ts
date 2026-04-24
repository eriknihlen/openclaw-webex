/**
 * OpenClaw Channel Plugin for Webex
 *
 * Implements the ChannelPlugin interface for OpenClaw's plugin system.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelPlugin, PluginRuntime } from "openclaw/plugin-sdk" with { "resolution-mode": "import" };
import { WebexWebhookHandler } from "./webhook";
import type { WebexChannelConfig } from "./types";
export declare function setPluginRuntime(runtime: PluginRuntime): void;
/** Resolved account configuration */
export interface ResolvedWebexAccount {
    accountId: string;
    name?: string;
    enabled: boolean;
    configured: boolean;
    config: WebexChannelConfig;
    token?: string;
    webhookUrl?: string;
}
/** Webhook target registration for HTTP handler */
type WebexWebhookTarget = {
    account: ResolvedWebexAccount;
    config: WebexChannelConfig;
    webhookHandler: WebexWebhookHandler;
};
export declare function registerWebexWebhookTarget(path: string, target: WebexWebhookTarget): () => void;
/**
 * Create the webhook handler with access to the plugin runtime.
 * Returns a handler function that can process incoming Webex webhook requests.
 */
export declare function createWebhookHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
export declare const webexPlugin: ChannelPlugin<ResolvedWebexAccount>;
export {};
