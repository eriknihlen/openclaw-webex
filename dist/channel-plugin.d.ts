/**
 * OpenClaw Channel Plugin for Webex
 *
 * Implements the ChannelPlugin interface for OpenClaw's plugin system.
 */
import type { ChannelPlugin, PluginRuntime } from "openclaw/plugin-sdk" with { "resolution-mode": "import" };
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
}
export declare const webexPlugin: ChannelPlugin<ResolvedWebexAccount>;
