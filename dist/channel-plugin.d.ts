/**
 * OpenClaw Channel Plugin for Webex
 *
 * Implements the ChannelPlugin interface for OpenClaw's plugin system.
 */
import type { ChannelPlugin, PluginRuntime } from "openclaw/plugin-sdk" with { "resolution-mode": "import" };
import type { WebexChannelConfig } from "./types";
import { type WebexSecretInput, type WebexSecretStatus } from "./secret-input";
export declare function setPluginRuntime(runtime: PluginRuntime): void;
/** Resolved account configuration */
export interface ResolvedWebexAccount {
    accountId: string;
    name?: string;
    enabled: boolean;
    configured: boolean;
    config: WebexChannelConfig;
    token?: string;
    /**
     * Credential state of the bot token. "configured_unavailable" means
     * the config holds a SecretRef the gateway did not resolve; the
     * account then reports configured but refuses to start or send.
     */
    tokenStatus?: WebexSecretStatus;
    /** Config path the token was read from (for error messages only). */
    tokenPath?: string;
}
/** Core config type for accessing channels.webex */
interface CoreConfig {
    channels?: {
        webex?: WebexChannelSection;
        defaults?: {
            groupPolicy?: string;
        };
    };
}
interface WebexChannelSection {
    enabled?: boolean;
    name?: string;
    /** Plaintext bot token or an OpenClaw SecretRef object. */
    token?: WebexSecretInput;
    dmPolicy?: "allow" | "deny" | "allowlisted" | "pairing";
    allowFrom?: string[];
    apiBaseUrl?: string;
    maxRetries?: number;
    retryDelayMs?: number;
    showProgressPlaceholder?: boolean;
    progressPlaceholderText?: string;
    progressVerbosity?: "silent" | "minimal" | "detailed";
    progressHeartbeatMs?: number;
    /**
     * OpenClaw agent id this Webex section dispatches to. Defaults to
     * "main"; set to a specific agent id to enable multi-agent
     * deployments where multiple bots on the same gateway dispatch to
     * different agents.
     */
    agent?: string;
    /**
     * Opt-in: stream reasoning text live into the progress message.
     *See WebexChannelConfig for caveats.
     */
    progressStreamReasoning?: boolean;
    /**
     * Base URL for the AIOps dashboard's approval API. See
     * WebexChannelConfig.aiopsApprovalUrl.
     */
    aiopsApprovalUrl?: string;
    /**
     * Shared secret sent as the `X-AIOps-Approval-Secret` header. See
     * WebexChannelConfig.aiopsApprovalSecret.
     */
    aiopsApprovalSecret?: WebexSecretInput;
    /**
     * Webex event bridge (see bridge.ts). When set, inbound events come
     * from the bridge's stream instead of a Mercury websocket in this
     * process. See WebexChannelConfig.bridgeUrl.
     */
    bridgeUrl?: string;
    /** Subscriber token for the bridge. Plaintext or an OpenClaw SecretRef object. */
    bridgeToken?: WebexSecretInput;
    /** Folder for inbound attachments. See WebexChannelConfig.inboundDir. */
    inboundDir?: string;
    /**
     * Allowed root directories for outbound local file sends. See
     * WebexChannelConfig.outboundFileRoots.
     */
    outboundFileRoots?: string[];
    /**
     * Chunk-count threshold above which a long reply is sent as a single
     * message with a markdown attachment instead of N chunked messages.
     * See WebexChannelConfig.longReplyAttachThreshold.
     */
    longReplyAttachThreshold?: number;
    accounts?: Record<string, WebexAccountConfig>;
}
interface WebexAccountConfig {
    enabled?: boolean;
    name?: string;
    /** Plaintext bot token or an OpenClaw SecretRef object. */
    token?: WebexSecretInput;
    dmPolicy?: "allow" | "deny" | "allowlisted" | "pairing";
    allowFrom?: string[];
    apiBaseUrl?: string;
    maxRetries?: number;
    retryDelayMs?: number;
    showProgressPlaceholder?: boolean;
    progressPlaceholderText?: string;
    progressVerbosity?: "silent" | "minimal" | "detailed";
    progressHeartbeatMs?: number;
    /**
     * OpenClaw agent id this named account dispatches to. Falls back to
     * the top-level section's agent, then to "main".
     */
    agent?: string;
    /**
     * Opt-in: stream reasoning text live into the progress message for
     * this account. Falls back to the top-level section's setting.
     */
    progressStreamReasoning?: boolean;
    /**
     * Base URL for the AIOps dashboard's approval API for this named
     * account. Falls back to the top-level section's setting.
     */
    aiopsApprovalUrl?: string;
    /**
     * Shared secret for this named account. Falls back to the top-level
     * section's setting. Plaintext or an OpenClaw SecretRef object.
     */
    aiopsApprovalSecret?: WebexSecretInput;
    /** Webex event bridge for this named account. Falls back to the top-level section's setting. */
    bridgeUrl?: string;
    /** Bridge subscriber token for this named account. Plaintext or an OpenClaw SecretRef object. */
    bridgeToken?: WebexSecretInput;
    /** Inbound attachment folder for this named account. Falls back to the top-level section's setting. */
    inboundDir?: string;
    /**
     * Allowed root directories for outbound local file sends for this
     * named account. Falls back to the top-level section's setting.
     */
    outboundFileRoots?: string[];
    /**
     * Long-reply attachment threshold for this named account. Falls back
     * to the top-level section's setting.
     */
    longReplyAttachThreshold?: number;
}
/**
 * Throws when the account's bot token is not a usable string (missing,
 * or a SecretRef the gateway did not resolve). Call before any Webex API
 * use so an unresolved ref never becomes `Bearer [object Object]` or an
 * empty bearer header.
 */
export declare function assertWebexTokenAvailable(account: ResolvedWebexAccount): void;
export declare function resolveWebexAccount(opts: {
    cfg: CoreConfig;
    accountId?: string;
}): ResolvedWebexAccount;
export declare const webexPlugin: ChannelPlugin<ResolvedWebexAccount>;
export {};
