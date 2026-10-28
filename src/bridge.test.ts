/**
 * Webex event bridge: server and client against each other on a real
 * loopback socket. Covers delivery, the token check, one subscriber at a
 * time, queueing while nobody is subscribed, and client reconnect.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { createBridgeServer, WebexBridgeTransport, type BridgeServer } from "./bridge";
import type { WebexWebhookPayload } from "./types";

const TOKEN = "test-bridge-token";

function payload(id: string): WebexWebhookPayload {
  return { id, resource: "messages", event: "created", data: { id: `m-${id}` } } as unknown as WebexWebhookPayload;
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let bridge: BridgeServer | undefined;
const clients: WebexBridgeTransport[] = [];

async function startServer(opts: Partial<Parameters<typeof createBridgeServer>[0]> = {}): Promise<string> {
  bridge = createBridgeServer({ bridgeToken: () => TOKEN, isUpstreamConnected: () => true, ...opts });
  await new Promise<void>((r) => bridge!.server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
}

function client(url: string, received: string[], token = TOKEN, logs: string[] = [], idleMs?: number) {
  const c = new WebexBridgeTransport(
    { bridgeUrl: url, bridgeToken: token },
    "test",
    { onPayload: (p) => received.push(p.id), onLog: (_l, m) => logs.push(m) },
    idleMs
  );
  clients.push(c);
  return c;
}

function get(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      resolve(res.statusCode ?? 0);
      res.destroy();
    });
    req.on("error", reject);
  });
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  await bridge?.close();
  bridge = undefined;
});

describe("webex bridge", () => {
  it("delivers events to the subscriber", async () => {
    const url = await startServer();
    const got: string[] = [];
    await client(url, got).start();
    await until(() => bridge!.stats().subscribed);
    bridge!.deliver(payload("a"));
    bridge!.deliver(payload("b"));
    await until(() => got.length === 2);
    expect(got).toEqual(["a", "b"]);
  });

  it("refuses a subscriber with the wrong token or none", async () => {
    const url = await startServer();
    expect(await get(`${url}/v1/events`)).toBe(401);
    expect(await get(`${url}/v1/events`, { Authorization: "Bearer nope" })).toBe(401);
    const logs: string[] = [];
    await client(url, [], "wrong", logs).start();
    await until(() => logs.some((l) => l.includes("HTTP 401")));
    expect(bridge!.stats().subscribed).toBe(false);
  });

  it("queues events while nobody is subscribed and sends them on subscribe", async () => {
    const url = await startServer();
    bridge!.deliver(payload("early"));
    expect(bridge!.stats().queued).toBe(1);
    const got: string[] = [];
    await client(url, got).start();
    await until(() => got.length === 1);
    expect(got).toEqual(["early"]);
    expect(bridge!.stats().queued).toBe(0);
  });

  it("drops queued events older than the age limit", async () => {
    const url = await startServer({ queueMaxAgeMs: 1 });
    bridge!.deliver(payload("old"));
    await new Promise((r) => setTimeout(r, 20));
    const got: string[] = [];
    await client(url, got).start();
    await until(() => bridge!.stats().subscribed);
    bridge!.deliver(payload("new"));
    await until(() => got.length === 1);
    expect(got).toEqual(["new"]);
    expect(bridge!.stats().dropped).toBe(1);
  });

  it("keeps one subscriber: a new one replaces the old", async () => {
    const url = await startServer();
    // The first subscriber is a raw stream (no reconnect), so the test sees the server end it.
    const firstEnded = new Promise<void>((resolve) => {
      http.get(`${url}/v1/events`, { headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
    });
    await until(() => bridge!.stats().subscribed);
    const second: string[] = [];
    await client(url, second).start();
    await firstEnded;
    await until(() => bridge!.stats().subscribed);
    bridge!.deliver(payload("x"));
    await until(() => second.length === 1);
    expect(second).toEqual(["x"]);
  });

  it("reconnects after the bridge restarts", async () => {
    const url = await startServer();
    const port = new URL(url).port;
    const got: string[] = [];
    await client(url, got).start();
    await until(() => bridge!.stats().subscribed);
    await bridge!.close();
    bridge = createBridgeServer({ bridgeToken: () => TOKEN, isUpstreamConnected: () => true });
    await new Promise<void>((r) => bridge!.server.listen(Number(port), "127.0.0.1", r));
    await until(() => bridge!.stats().subscribed, 5_000);
    bridge!.deliver(payload("after"));
    await until(() => got.length === 1);
    expect(got).toEqual(["after"]);
  });

  it("reports health from the upstream state", async () => {
    let up = false;
    const url = await startServer({ isUpstreamConnected: () => up });
    expect(await get(`${url}/healthz`)).toBe(503);
    up = true;
    expect(await get(`${url}/healthz`)).toBe(200);
  });

  it("rejects a bridge URL that is not http(s) and a missing token", () => {
    expect(() => client("ftp://x", [])).toThrow(/http/);
    expect(() => client("http://x", [], "")).toThrow(/bridgeToken/);
  });
});
