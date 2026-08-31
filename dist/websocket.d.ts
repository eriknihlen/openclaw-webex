/**
 * Webex Mercury WebSocket Transport
 *
 * Receives Webex events over an OUTBOUND wss:// connection to Cisco's
 * Mercury push service instead of inbound HTTP webhooks. This removes
 * the public-URL requirement entirely (no ngrok, no webhookSecret):
 * everything is outbound TCP 443 to *.wbx2.com, the same egress the
 * REST calls already use.
 *
 * Flow:
 *   1. POST wdm-a.wbx2.com/wdm/api/v1/devices  → device registration,
 *      response carries a one-off webSocketUrl (stale same-name devices
 *      are pruned first so we never pile up toward the WDM device cap).
 *   2. Open the websocket (Node >= 22 global WebSocket — no new deps),
 *      send an `authorization` frame with the bot token.
 *   3. Mercury pushes `conversation.activity` events. We map them to the
 *      same WebexWebhookPayload shape the webhook path produces (Hydra
 *      base64url ids), so ALL downstream processing — allowlist, bot
 *      self-filter, message fetch, envelope normalization, dispatch —
 *      is byte-for-byte the same code as webhook mode.
 *   4. App-level ping/pong keepalive; on silence or close, reconnect
 *      with exponential backoff and a fresh device registration.
 *
 * Verb mapping (matches what the official webex-js-sdk listeners do):
 *   post / share  → resource "messages",          event "created"
 *   cardAction    → resource "attachmentActions", event "created"
 * Everything else (acks, typing, membership churn) is ignored.
 */
import type { WebexChannelConfig, WebexWebhookPayload } from "./types";
/** Build a Hydra-format Webex API id from a bare Mercury UUID. */
export declare function hydraId(kind: "MESSAGE" | "PEOPLE" | "ROOM" | "ATTACHMENT_ACTION", uuid: string): string;
export interface MercuryTransportCallbacks {
    /**
     * Receives synthesized webhook-shaped payloads. The caller routes them
     * through the exact same WebexWebhookHandler methods the HTTP webhook
     * endpoint uses.
     */
    onPayload: (payload: WebexWebhookPayload) => void;
    onLog?: (level: "info" | "warn" | "error", msg: string) => void;
}
export declare class WebexMercuryTransport {
    private readonly config;
    private readonly accountId;
    private readonly callbacks;
    private ws?;
    private stopped;
    private deviceUrl?;
    private pingTimer?;
    private pongTimer?;
    private reconnectTimer?;
    private refreshTimer?;
    private backoffMs;
    constructor(config: WebexChannelConfig, accountId: string, callbacks: MercuryTransportCallbacks);
    private log;
    /**
     * Register the device and open the first connection. Throws if the
     * initial device registration fails (so startup surfaces a clear
     * error); later reconnects are handled internally and never throw.
     */
    start(): Promise<void>;
    /**
     * Arm (or re-arm) the daily connection refresh. Runs from the `open`
     * handler so the 24h clock restarts on every successful connect —
     * including reconnects triggered by the refresh itself.
     */
    private scheduleRefresh;
    /** Close the socket and best-effort delete the WDM device. */
    stop(): Promise<void>;
    /**
     * Register (or re-register) with WDM. Prunes previous devices created
     * under our name first so restarts don't accumulate toward the
     * per-account device cap.
     */
    private registerDevice;
    private connect;
    /** Node's global WebSocket may deliver text, ArrayBuffer, or Blob. */
    private decodeFrame;
    private handleFrame;
    /**
     * Map a Mercury conversation.activity to the WebexWebhookPayload shape
     * the webhook endpoint receives. Ids are converted to Hydra base64url
     * so the REST fetches, allowlist matching, and bot self-filtering
     * downstream behave identically to webhook mode.
     */
    private activityToPayload;
    private startPing;
    private clearTimers;
    private scheduleReconnect;
}
