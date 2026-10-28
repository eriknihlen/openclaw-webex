"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebexBridgeTransport = exports.BRIDGE_HEALTH_PATH = exports.BRIDGE_EVENTS_PATH = void 0;
exports.createBridgeServer = createBridgeServer;
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const node_crypto_1 = require("node:crypto");
exports.BRIDGE_EVENTS_PATH = "/v1/events";
exports.BRIDGE_HEALTH_PATH = "/healthz";
const PING_INTERVAL_MS = 15_000;
/** Client side: no byte (event or ping) for this long means a dead stream. */
const IDLE_TIMEOUT_MS = 45_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const QUEUE_MAX = 200;
const QUEUE_MAX_AGE_MS = 15 * 60 * 1_000;
function tokenMatches(header, token) {
    const given = Buffer.from(header ?? "");
    const want = Buffer.from(`Bearer ${token}`);
    return given.length === want.length && (0, node_crypto_1.timingSafeEqual)(given, want);
}
function createBridgeServer(opts) {
    const log = (level, msg) => opts.onLog?.(level, msg);
    const queueMax = opts.queueMax ?? QUEUE_MAX;
    const queueMaxAgeMs = opts.queueMaxAgeMs ?? QUEUE_MAX_AGE_MS;
    const queue = [];
    let subscriber;
    let delivered = 0;
    let dropped = 0;
    const write = (res, payload) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        delivered++;
    };
    const flushQueue = (res) => {
        const now = Date.now();
        let stale = 0;
        for (const item of queue.splice(0)) {
            if (now - item.at > queueMaxAgeMs)
                stale++;
            else
                write(res, item.payload);
        }
        if (stale) {
            dropped += stale;
            log("warn", `dropped ${stale} queued event(s) older than ${queueMaxAgeMs / 60_000} minutes`);
        }
    };
    const ping = setInterval(() => {
        subscriber?.write(": ping\n\n");
    }, opts.pingIntervalMs ?? PING_INTERVAL_MS);
    ping.unref();
    const server = node_http_1.default.createServer((req, res) => {
        const path = (req.url ?? "").split("?")[0];
        if (req.method === "GET" && path === exports.BRIDGE_HEALTH_PATH) {
            const up = opts.isUpstreamConnected();
            res.writeHead(up ? 200 : 503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ mercury: up, subscribed: Boolean(subscriber), queued: queue.length, delivered, dropped }));
            return;
        }
        if (req.method !== "GET" || path !== exports.BRIDGE_EVENTS_PATH) {
            res.writeHead(404).end();
            return;
        }
        if (!tokenMatches(req.headers.authorization, opts.bridgeToken())) {
            log("warn", `refused a subscriber from ${req.socket.remoteAddress}: wrong or missing token`);
            res.writeHead(401).end();
            return;
        }
        if (subscriber) {
            log("info", "new subscriber replaces the previous one");
            subscriber.end();
        }
        req.socket.setKeepAlive(true, 10_000);
        req.socket.setNoDelay(true);
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
        });
        res.write(": subscribed\n\n");
        subscriber = res;
        log("info", `subscriber connected from ${req.socket.remoteAddress}`);
        flushQueue(res);
        res.on("close", () => {
            if (subscriber === res) {
                subscriber = undefined;
                log("info", "subscriber disconnected; queueing events");
            }
        });
    });
    return {
        server,
        deliver: (payload) => {
            if (subscriber && !subscriber.writableEnded) {
                write(subscriber, payload);
                return;
            }
            queue.push({ at: Date.now(), payload });
            if (queue.length > queueMax) {
                queue.shift();
                dropped++;
                log("warn", `queue full (${queueMax}): dropped the oldest event`);
            }
        },
        stats: () => ({ subscribed: Boolean(subscriber), queued: queue.length, delivered, dropped }),
        close: () => new Promise((resolve) => {
            clearInterval(ping);
            subscriber?.end();
            server.close(() => resolve());
            server.closeAllConnections?.();
        }),
    };
}
/**
 * Subscribes to the bridge's event stream and hands each payload to the
 * same callbacks the Mercury transport uses. Reconnects with backoff on
 * any error, refusal or silence; never throws after start().
 */
class WebexBridgeTransport {
    config;
    accountId;
    callbacks;
    idleTimeoutMs;
    stopped = false;
    req;
    idleTimer;
    reconnectTimer;
    backoffMs = BACKOFF_MIN_MS;
    url;
    constructor(config, accountId, callbacks, idleTimeoutMs = IDLE_TIMEOUT_MS) {
        this.config = config;
        this.accountId = accountId;
        this.callbacks = callbacks;
        this.idleTimeoutMs = idleTimeoutMs;
        this.url = new URL(exports.BRIDGE_EVENTS_PATH, config.bridgeUrl);
        if (this.url.protocol !== "http:" && this.url.protocol !== "https:") {
            throw new Error(`Webex bridgeUrl must be http(s): ${config.bridgeUrl}`);
        }
        if (!config.bridgeToken) {
            throw new Error(`Webex account ${accountId} has bridgeUrl but no bridgeToken`);
        }
    }
    log(level, msg) {
        this.callbacks.onLog?.(level, `[webex:${this.accountId}] ${msg}`);
    }
    async start() {
        this.stopped = false;
        this.connect();
    }
    async stop() {
        this.stopped = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        this.req?.destroy();
        this.req = undefined;
    }
    armIdle(req) {
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (this.req !== req)
                return;
            this.log("warn", "bridge stream silent; reconnecting");
            this.scheduleReconnect("idle timeout");
        }, this.idleTimeoutMs);
    }
    connect() {
        const lib = this.url.protocol === "https:" ? node_https_1.default : node_http_1.default;
        const req = lib.request(this.url, {
            method: "GET",
            headers: { Authorization: `Bearer ${this.config.bridgeToken}`, Accept: "text/event-stream" },
        });
        this.req = req;
        this.armIdle(req);
        req.on("response", (res) => {
            if (this.req !== req) {
                res.destroy();
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                this.scheduleReconnect(`bridge answered HTTP ${res.statusCode}`);
                return;
            }
            this.backoffMs = BACKOFF_MIN_MS;
            this.log("info", `bridge event stream connected (${this.url.host})`);
            res.setEncoding("utf8");
            let buffer = "";
            res.on("data", (chunk) => {
                if (this.req !== req)
                    return;
                this.armIdle(req);
                buffer += chunk;
                let end;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                    const block = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    this.handleBlock(block);
                }
            });
            res.on("end", () => {
                if (this.req === req)
                    this.scheduleReconnect("bridge closed the stream");
            });
            res.on("error", () => {
                if (this.req === req)
                    this.scheduleReconnect("stream error");
            });
        });
        req.on("error", (err) => {
            if (this.req === req)
                this.scheduleReconnect(err.message);
        });
        req.end();
    }
    handleBlock(block) {
        const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
        if (!data)
            return; // comment (ping) or empty
        let payload;
        try {
            payload = JSON.parse(data);
        }
        catch {
            this.log("warn", "bridge sent an event that is not JSON; ignored");
            return;
        }
        this.callbacks.onPayload(payload);
    }
    scheduleReconnect(reason) {
        const old = this.req;
        this.req = undefined;
        old?.destroy();
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        if (this.stopped || this.reconnectTimer)
            return;
        const delay = this.backoffMs + Math.floor(Math.random() * (this.backoffMs / 2));
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        this.log("info", `bridge reconnecting in ${delay}ms (${reason})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (!this.stopped)
                this.connect();
        }, delay);
    }
}
exports.WebexBridgeTransport = WebexBridgeTransport;
//# sourceMappingURL=bridge.js.map