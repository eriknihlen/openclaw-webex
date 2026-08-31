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

import fetch from "node-fetch";
import { randomUUID } from "crypto";
import type { WebexChannelConfig, WebexWebhookPayload } from "./types";

const WDM_DEVICES_URL = "https://wdm-a.wbx2.com/wdm/api/v1/devices";
const DEVICE_NAME = "openclaw-webex-plugin";

const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** Build a Hydra-format Webex API id from a bare Mercury UUID. */
export function hydraId(
  kind: "MESSAGE" | "PEOPLE" | "ROOM" | "ATTACHMENT_ACTION",
  uuid: string
): string {
  return Buffer.from(`ciscospark://us/${kind}/${uuid}`).toString("base64url");
}

interface MercuryActivity {
  id?: string;
  verb?: string;
  actor?: { id?: string; emailAddress?: string };
  target?: { id?: string };
  object?: { id?: string };
}

export interface MercuryTransportCallbacks {
  /**
   * Receives synthesized webhook-shaped payloads. The caller routes them
   * through the exact same WebexWebhookHandler methods the HTTP webhook
   * endpoint uses.
   */
  onPayload: (payload: WebexWebhookPayload) => void;
  onLog?: (level: "info" | "warn" | "error", msg: string) => void;
}

export class WebexMercuryTransport {
  private ws?: WebSocket;
  private stopped = false;
  private deviceUrl?: string;
  private pingTimer?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private backoffMs = BACKOFF_MIN_MS;

  constructor(
    private readonly config: WebexChannelConfig,
    private readonly accountId: string,
    private readonly callbacks: MercuryTransportCallbacks
  ) {}

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.callbacks.onLog?.(level, `[webex:${this.accountId}] ${msg}`);
  }

  /**
   * Register the device and open the first connection. Throws if the
   * initial device registration fails (so startup surfaces a clear
   * error); later reconnects are handled internally and never throw.
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /** Close the socket and best-effort delete the WDM device. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = undefined;
    if (this.deviceUrl) {
      try {
        await fetch(this.deviceUrl, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.config.token}` },
        });
      } catch {
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
  private async registerDevice(): Promise<string> {
    const auth = { Authorization: `Bearer ${this.config.token}` };

    try {
      const listRes = await fetch(WDM_DEVICES_URL, { headers: auth });
      if (listRes.ok) {
        const body = (await listRes.json()) as {
          devices?: Array<{ url?: string; name?: string; deviceName?: string }>;
        };
        for (const device of body.devices ?? []) {
          const name = device.name ?? device.deviceName;
          if (name === DEVICE_NAME && device.url) {
            await fetch(device.url, { method: "DELETE", headers: auth }).catch(
              () => {}
            );
          }
        }
      }
    } catch {
      // listing is advisory; registration below is what matters
    }

    const res = await fetch(WDM_DEVICES_URL, {
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
      throw new Error(
        `WDM device registration failed: ${res.status} ${res.statusText} ${text}`.trim()
      );
    }
    const body = (await res.json()) as { url?: string; webSocketUrl?: string };
    if (!body.webSocketUrl) {
      throw new Error("WDM device registration returned no webSocketUrl");
    }
    this.deviceUrl = body.url;
    return body.webSocketUrl;
  }

  private async connect(): Promise<void> {
    const wsUrl = await this.registerDevice();
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoffMs = BACKOFF_MIN_MS;
      ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: "authorization",
          data: { token: `Bearer ${this.config.token}` },
        })
      );
      this.startPing();
      this.log("info", "mercury websocket connected");
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      void this.decodeFrame(event.data).then((text) => {
        if (text) this.handleFrame(text);
      });
    });

    ws.addEventListener("close", () => {
      this.scheduleReconnect("socket closed");
    });

    ws.addEventListener("error", () => {
      // the close event follows and drives the reconnect
      this.log("warn", "mercury websocket error");
    });
  }

  /** Node's global WebSocket may deliver text, ArrayBuffer, or Blob. */
  private async decodeFrame(data: unknown): Promise<string | undefined> {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
    if (
      data &&
      typeof (data as { text?: () => Promise<string> }).text === "function"
    ) {
      try {
        return await (data as { text: () => Promise<string> }).text();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private handleFrame(text: string): void {
    let frame: {
      type?: string;
      data?: { eventType?: string; activity?: MercuryActivity };
    };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }

    if (frame.type === "pong") {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
      }
      return;
    }

    if (frame.data?.eventType !== "conversation.activity") return;
    const activity = frame.data.activity;
    if (!activity?.id || !activity.verb) return;

    const payload = this.activityToPayload(activity);
    if (payload) this.callbacks.onPayload(payload);
  }

  /**
   * Map a Mercury conversation.activity to the WebexWebhookPayload shape
   * the webhook endpoint receives. Ids are converted to Hydra base64url
   * so the REST fetches, allowlist matching, and bot self-filtering
   * downstream behave identically to webhook mode.
   */
  private activityToPayload(
    activity: MercuryActivity
  ): WebexWebhookPayload | null {
    const actorUuid = activity.actor?.id;
    const roomUuid = activity.target?.id;
    const base = {
      id: randomUUID(),
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
            id: hydraId("MESSAGE", activity.id!),
            roomId: roomUuid ? hydraId("ROOM", roomUuid) : "",
            personId: actorUuid ? hydraId("PEOPLE", actorUuid) : "",
            personEmail: activity.actor?.emailAddress ?? "",
          },
        } as WebexWebhookPayload;
      case "cardAction":
        return {
          ...base,
          resource: "attachmentActions",
          event: "created",
          data: {
            id: hydraId("ATTACHMENT_ACTION", activity.object?.id ?? activity.id!),
            roomId: roomUuid ? hydraId("ROOM", roomUuid) : "",
            personId: actorUuid ? hydraId("PEOPLE", actorUuid) : "",
            personEmail: activity.actor?.emailAddress ?? "",
          },
        } as WebexWebhookPayload;
      default:
        return null;
    }
  }

  private startPing(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ id: randomUUID(), type: "ping" }));
      } catch {
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

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = undefined;
    if (this.reconnectTimer) return; // one pending reconnect at a time

    const delay =
      this.backoffMs + Math.floor(Math.random() * (this.backoffMs / 2));
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.log("info", `mercury reconnecting in ${delay}ms (${reason})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((err) => {
        this.log(
          "warn",
          `mercury reconnect failed: ${err instanceof Error ? err.message : err}`
        );
        this.scheduleReconnect("reconnect failed");
      });
    }, delay);
  }
}
