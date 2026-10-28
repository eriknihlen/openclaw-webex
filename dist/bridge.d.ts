/**
 * Webex event bridge
 *
 * Moves the Mercury websocket out of the gateway process. A separate
 * bridge process (bridge-main.ts) holds the Mercury connection with the
 * bot token and serves the events it receives as a Server-Sent Events
 * stream on a private network. The plugin, in the gateway, reads that
 * stream instead of opening Mercury itself (`bridgeUrl` in the account).
 *
 * Why: an egress guardrail in the gateway process (DefenseClaw's fetch
 * interceptor) classifies the Mercury URL as model traffic (its path
 * contains "/messages") and reroutes it through its proxy, where the
 * websocket's ping/pong keepalive fails. The bridge has no interceptor;
 * the gateway's request to the bridge is ordinary internal HTTP. Every
 * REST call (message fetch, replies, cards) stays in the gateway.
 *
 *   Webex Mercury ──wss──▶ bridge ──SSE /v1/events──▶ gateway plugin
 *
 * The stream carries the same webhook-shaped payloads the Mercury
 * transport produces, so all downstream processing is unchanged.
 *
 * Protocol (GET /v1/events, Authorization: Bearer <bridge token>):
 *   `data: <WebexWebhookPayload JSON>` per event, `: ping` every 15s.
 *   One subscriber at a time: a new subscriber replaces the previous one
 *   (a restarted gateway must not leave a second consumer behind, which
 *   would answer every message twice). Events that arrive while nobody
 *   is subscribed are kept (bounded, max 15 minutes) and sent on the next
 *   subscribe, so a gateway restart does not lose messages.
 * GET /healthz: 200 when Mercury is connected, else 503; counts only.
 */
import http from "node:http";
import type { WebexWebhookPayload } from "./types";
import type { MercuryTransportCallbacks } from "./websocket";
export declare const BRIDGE_EVENTS_PATH = "/v1/events";
export declare const BRIDGE_HEALTH_PATH = "/healthz";
export interface BridgeServerOptions {
    /** Read on every subscribe, so a rotated token needs no restart. */
    bridgeToken: () => string;
    /** Whether the Mercury connection is up (health endpoint). */
    isUpstreamConnected: () => boolean;
    onLog?: (level: "info" | "warn" | "error", msg: string) => void;
    pingIntervalMs?: number;
    queueMax?: number;
    queueMaxAgeMs?: number;
}
export interface BridgeServer {
    server: http.Server;
    /** Hand one event to the subscriber, or keep it until one subscribes. */
    deliver: (payload: WebexWebhookPayload) => void;
    stats: () => {
        subscribed: boolean;
        queued: number;
        delivered: number;
        dropped: number;
    };
    close: () => Promise<void>;
}
export declare function createBridgeServer(opts: BridgeServerOptions): BridgeServer;
export interface BridgeClientConfig {
    bridgeUrl: string;
    bridgeToken: string;
}
/**
 * Subscribes to the bridge's event stream and hands each payload to the
 * same callbacks the Mercury transport uses. Reconnects with backoff on
 * any error, refusal or silence; never throws after start().
 */
export declare class WebexBridgeTransport {
    private readonly config;
    private readonly accountId;
    private readonly callbacks;
    private readonly idleTimeoutMs;
    private stopped;
    private req?;
    private idleTimer?;
    private reconnectTimer?;
    private backoffMs;
    private readonly url;
    constructor(config: BridgeClientConfig, accountId: string, callbacks: MercuryTransportCallbacks, idleTimeoutMs?: number);
    private log;
    start(): Promise<void>;
    stop(): Promise<void>;
    private armIdle;
    private connect;
    private handleBlock;
    private scheduleReconnect;
}
