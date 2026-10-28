"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebexMercuryTransport = void 0;
exports.hydraId = hydraId;
const node_fetch_1 = __importDefault(require("node-fetch"));
const crypto_1 = require("crypto");
const WDM_DEVICES_URL = "https://wdm-a.wbx2.com/wdm/api/v1/devices";
const DEVICE_NAME = "openclaw-webex-plugin";
const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/**
 * Scheduled connection refresh: proactively tear down and rebuild the
 * connection (with a fresh WDM device registration) every 24h, ±1h of
 * jitter so multiple accounts don't refresh in lockstep. This bounds the
 * rare "stale delivery" failure mode — a socket that still answers pongs
 * while Cisco's side has stopped routing events to the registration —
 * to at most one day. The refresh costs a ~2s reconnect window.
 */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const REFRESH_JITTER_MS = 60 * 60 * 1_000;
/**
 * Inbound dedup window. Mercury activity ids are UUIDs; we remember the
 * most recent MAX_SEEN_ACTIVITY_IDS and drop a repeat. This is the
 * belt-and-braces layer behind the socket-generation guard in connect():
 * even if a stale socket somehow survives, the same message cannot reach
 * the agent twice.
 */
const MAX_SEEN_ACTIVITY_IDS = 1_000;
/** Build a Hydra-format Webex API id from a bare Mercury UUID. */
function hydraId(kind, uuid) {
    return Buffer.from(`ciscospark://us/${kind}/${uuid}`).toString("base64url");
}
class WebexMercuryTransport {
    config;
    accountId;
    callbacks;
    ws;
    stopped = false;
    deviceUrl;
    pingTimer;
    pongTimer;
    reconnectTimer;
    refreshTimer;
    backoffMs = BACKOFF_MIN_MS;
    /**
     * Monotonic connect() generation. Incremented on every connect() call;
     * a connect() that finds itself superseded after its async device
     * registration abandons without opening a socket. Socket event handlers
     * also compare `this.ws` to their own socket and ignore stale events.
     *
     * Why: the daily "scheduled refresh" raced the old socket's late `close`
     * event. connect() awaits registerDevice() (an HTTP round-trip) before
     * assigning this.ws, so when the late close arrived this.ws was still
     * undefined, the "one pending reconnect" guard passed, and a SECOND
     * connect() ran. The first socket then opened and was orphaned when the
     * second overwrote this.ws — still open, still delivering every inbound
     * message to handleFrame(). One extra socket per day; each message was
     * processed once per live socket ("Working on it…" ×2, ×3, …).
     */
    connectGeneration = 0;
    /** Insertion-ordered set of recent Mercury activity ids (see MAX_SEEN_ACTIVITY_IDS). */
    seenActivityIds = new Set();
    constructor(config, accountId, callbacks) {
        this.config = config;
        this.accountId = accountId;
        this.callbacks = callbacks;
    }
    log(level, msg) {
        this.callbacks.onLog?.(level, `[webex:${this.accountId}] ${msg}`);
    }
    /** True while the current socket is open (the bridge's health check). */
    get connected() {
        return this.ws?.readyState === WebSocket.OPEN;
    }
    /**
     * Register the device and open the first connection. Throws if the
     * initial device registration fails (so startup surfaces a clear
     * error); later reconnects are handled internally and never throw.
     */
    async start() {
        this.stopped = false;
        await this.connect();
    }
    /**
     * Arm (or re-arm) the daily connection refresh. Runs from the `open`
     * handler so the 24h clock restarts on every successful connect —
     * including reconnects triggered by the refresh itself.
     */
    scheduleRefresh() {
        if (this.refreshTimer)
            clearTimeout(this.refreshTimer);
        const delay = REFRESH_INTERVAL_MS + Math.floor(Math.random() * REFRESH_JITTER_MS);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            if (this.stopped)
                return;
            this.log("info", "scheduled connection refresh (staleness guard)");
            this.scheduleReconnect("scheduled refresh");
        }, delay);
    }
    /** Close the socket and best-effort delete the WDM device. */
    async stop() {
        this.stopped = true;
        this.clearTimers();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.refreshTimer)
            clearTimeout(this.refreshTimer);
        try {
            this.ws?.close();
        }
        catch {
            /* already closed */
        }
        this.ws = undefined;
        if (this.deviceUrl) {
            try {
                await (0, node_fetch_1.default)(this.deviceUrl, {
                    method: "DELETE",
                    headers: { Authorization: `Bearer ${this.config.token}` },
                });
            }
            catch {
                // best-effort — a stale device is pruned on the next start anyway
            }
            this.deviceUrl = undefined;
        }
    }
    /**
     * Register (or re-register) with WDM. Prunes previous devices created
     * under our name first so restarts don't accumulate toward the
     * per-account device cap.
     */
    async registerDevice() {
        const auth = { Authorization: `Bearer ${this.config.token}` };
        try {
            const listRes = await (0, node_fetch_1.default)(WDM_DEVICES_URL, { headers: auth });
            if (listRes.ok) {
                const body = (await listRes.json());
                for (const device of body.devices ?? []) {
                    const name = device.name ?? device.deviceName;
                    if (name === DEVICE_NAME && device.url) {
                        await (0, node_fetch_1.default)(device.url, { method: "DELETE", headers: auth }).catch(() => { });
                    }
                }
            }
        }
        catch {
            // listing is advisory; registration below is what matters
        }
        const res = await (0, node_fetch_1.default)(WDM_DEVICES_URL, {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({
                deviceName: DEVICE_NAME,
                deviceType: "DESKTOP",
                localizedModel: "nodejs",
                model: "nodejs",
                name: DEVICE_NAME,
                systemName: "openclaw-webex-plugin",
                systemVersion: "0.2.0",
            }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`WDM device registration failed: ${res.status} ${res.statusText} ${text}`.trim());
        }
        const body = (await res.json());
        if (!body.webSocketUrl) {
            throw new Error("WDM device registration returned no webSocketUrl");
        }
        this.deviceUrl = body.url;
        return body.webSocketUrl;
    }
    async connect() {
        const generation = ++this.connectGeneration;
        const wsUrl = await this.registerDevice();
        // Superseded while registering (another connect() started, or stop()
        // was called): do not open a socket that nobody will ever own.
        if (this.stopped || generation !== this.connectGeneration) {
            this.log("info", "mercury connect superseded during registration — abandoned");
            return;
        }
        // Never let two sockets coexist. If a previous socket is still
        // attached, discard it; its handlers below will see this.ws !== ws
        // and go inert, so its late close cannot trigger another reconnect.
        const previous = this.ws;
        if (previous) {
            this.log("warn", "mercury replacing a still-attached socket");
            this.discardSocket(previous);
        }
        const ws = new WebSocket(wsUrl);
        this.ws = ws;
        ws.addEventListener("open", () => {
            if (this.ws !== ws) {
                // Opened after being superseded — close it, do not adopt it.
                this.discardSocket(ws);
                return;
            }
            this.backoffMs = BACKOFF_MIN_MS;
            ws.send(JSON.stringify({
                id: (0, crypto_1.randomUUID)(),
                type: "authorization",
                data: { token: `Bearer ${this.config.token}` },
            }));
            this.startPing();
            this.scheduleRefresh();
            this.log("info", "mercury websocket connected");
        });
        ws.addEventListener("message", (event) => {
            if (this.ws !== ws)
                return; // stale socket: drop, never deliver
            void this.decodeFrame(event.data).then((text) => {
                if (text && this.ws === ws)
                    this.handleFrame(text);
            });
        });
        ws.addEventListener("close", () => {
            // A stale socket closing is expected housekeeping, not an outage.
            // Only the CURRENT socket's close drives a reconnect — this is the
            // guard that stops the daily refresh from doubling the connection.
            if (this.ws !== ws)
                return;
            this.scheduleReconnect("socket closed");
        });
        ws.addEventListener("error", () => {
            if (this.ws !== ws)
                return;
            // the close event follows and drives the reconnect
            this.log("warn", "mercury websocket error");
        });
    }
    /** Close a socket we no longer own. Its handlers self-neutralise via this.ws checks. */
    discardSocket(ws) {
        try {
            ws.close();
        }
        catch {
            /* already closed */
        }
    }
    /** Node's global WebSocket may deliver text, ArrayBuffer, or Blob. */
    async decodeFrame(data) {
        if (typeof data === "string")
            return data;
        if (data instanceof ArrayBuffer)
            return Buffer.from(data).toString("utf-8");
        if (data &&
            typeof data.text === "function") {
            try {
                return await data.text();
            }
            catch {
                return undefined;
            }
        }
        return undefined;
    }
    handleFrame(text) {
        let frame;
        try {
            frame = JSON.parse(text);
        }
        catch {
            return;
        }
        if (frame.type === "pong") {
            if (this.pongTimer) {
                clearTimeout(this.pongTimer);
                this.pongTimer = undefined;
            }
            return;
        }
        if (frame.data?.eventType !== "conversation.activity")
            return;
        const activity = frame.data.activity;
        if (!activity?.id || !activity.verb)
            return;
        if (this.isDuplicateActivity(activity.id)) {
            this.log("warn", `mercury duplicate activity ${activity.id} dropped`);
            return;
        }
        const payload = this.activityToPayload(activity);
        if (payload)
            this.callbacks.onPayload(payload);
    }
    /**
     * Remember `id`; report whether it was already seen. Bounded FIFO —
     * Set preserves insertion order, so evicting the first key is oldest.
     */
    isDuplicateActivity(id) {
        if (this.seenActivityIds.has(id))
            return true;
        this.seenActivityIds.add(id);
        if (this.seenActivityIds.size > MAX_SEEN_ACTIVITY_IDS) {
            const oldest = this.seenActivityIds.values().next().value;
            if (oldest !== undefined)
                this.seenActivityIds.delete(oldest);
        }
        return false;
    }
    /**
     * Map a Mercury conversation.activity to the WebexWebhookPayload shape
     * the webhook endpoint receives. Ids are converted to Hydra base64url
     * so the REST fetches, allowlist matching, and bot self-filtering
     * downstream behave identically to webhook mode.
     */
    activityToPayload(activity) {
        const actorUuid = activity.actor?.id;
        const roomUuid = activity.target?.id;
        const base = {
            id: (0, crypto_1.randomUUID)(),
            name: "mercury",
            targetUrl: "",
            orgId: "",
            createdBy: "",
            appId: "",
            ownedBy: "creator",
            status: "active",
            created: new Date().toISOString(),
            actorId: actorUuid ? hydraId("PEOPLE", actorUuid) : "",
        };
        switch (activity.verb) {
            case "post":
            case "share":
                return {
                    ...base,
                    resource: "messages",
                    event: "created",
                    data: {
                        id: hydraId("MESSAGE", activity.id),
                        roomId: roomUuid ? hydraId("ROOM", roomUuid) : "",
                        personId: actorUuid ? hydraId("PEOPLE", actorUuid) : "",
                        personEmail: activity.actor?.emailAddress ?? "",
                    },
                };
            case "cardAction":
                return {
                    ...base,
                    resource: "attachmentActions",
                    event: "created",
                    data: {
                        id: hydraId("ATTACHMENT_ACTION", activity.object?.id ?? activity.id),
                        roomId: roomUuid ? hydraId("ROOM", roomUuid) : "",
                        personId: actorUuid ? hydraId("PEOPLE", actorUuid) : "",
                        personEmail: activity.actor?.emailAddress ?? "",
                    },
                };
            default:
                return null;
        }
    }
    startPing() {
        this.clearTimers();
        this.pingTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN)
                return;
            try {
                ws.send(JSON.stringify({ id: (0, crypto_1.randomUUID)(), type: "ping" }));
            }
            catch {
                this.scheduleReconnect("ping send failed");
                return;
            }
            if (!this.pongTimer) {
                this.pongTimer = setTimeout(() => {
                    this.log("warn", "mercury pong timeout");
                    this.scheduleReconnect("pong timeout");
                }, PONG_TIMEOUT_MS);
            }
        }, PING_INTERVAL_MS);
    }
    clearTimers() {
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        if (this.pongTimer)
            clearTimeout(this.pongTimer);
        this.pingTimer = undefined;
        this.pongTimer = undefined;
    }
    scheduleReconnect(reason) {
        if (this.stopped)
            return;
        this.clearTimers();
        try {
            this.ws?.close();
        }
        catch {
            /* already closed */
        }
        this.ws = undefined;
        if (this.reconnectTimer)
            return; // one pending reconnect at a time
        const delay = this.backoffMs + Math.floor(Math.random() * (this.backoffMs / 2));
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        this.log("info", `mercury reconnecting in ${delay}ms (${reason})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect().catch((err) => {
                this.log("warn", `mercury reconnect failed: ${err instanceof Error ? err.message : err}`);
                this.scheduleReconnect("reconnect failed");
            });
        }, delay);
    }
}
exports.WebexMercuryTransport = WebexMercuryTransport;
//# sourceMappingURL=websocket.js.map