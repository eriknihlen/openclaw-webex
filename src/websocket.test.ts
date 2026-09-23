/**
 * Regression tests for the Mercury transport's reconnect race.
 *
 * Background (2026-09-23): the daily "scheduled refresh" closed the old
 * socket and armed a reconnect. connect() awaits registerDevice() before
 * assigning this.ws, so when the OLD socket's late `close` event arrived,
 * this.ws was still undefined, the "one pending reconnect" guard passed,
 * and a second connect() ran. The first socket opened and was orphaned —
 * still delivering every inbound message. One extra socket per day; each
 * Webex message was processed once per live socket ("Working on it…" ×N).
 *
 * These tests drive the exact ordering with a deferred registration and a
 * fake WebSocket, and assert: one socket, one delivery, no reconnect storm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── fake node-fetch (WDM device registration) ────────────────────────────
const fetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => fetchMock(...args) }));

type Listener = (ev: { data?: unknown }) => void;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  closed = false;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    // NB: like a real TLS socket, the `close` event is NOT dispatched
    // synchronously — tests fire it explicitly to model a late arrival.
  }
  emit(type: string, ev: { data?: unknown } = {}): void {
    if (type === "open") this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

function okJson(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => "" };
}

/** A fetch mock whose POST (device registration) can be held and released. */
function deferrableFetch() {
  const pending: Array<(v: unknown) => void> = [];
  fetchMock.mockImplementation(async (_url: unknown, init?: { method?: string }) => {
    if (init?.method === "POST") {
      return new Promise((resolve) => {
        pending.push(() => resolve(okJson({ url: "https://wdm/dev/1", webSocketUrl: "wss://mercury/x" })));
      });
    }
    if (init?.method === "DELETE") return okJson({});
    return okJson({ devices: [] }); // GET list
  });
  return {
    /** Resolve the oldest held registration. */
    release: () => pending.shift()?.(undefined),
    get held() {
      return pending.length;
    },
  };
}

async function flush(): Promise<void> {
  // let awaited fetches / then-chains settle under fake timers
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const activityFrame = (id: string) =>
  JSON.stringify({
    data: {
      eventType: "conversation.activity",
      activity: { id, verb: "post", actor: { id: "a1" }, target: { id: "r1" } },
    },
  });

let WebexMercuryTransport: typeof import("./websocket").WebexMercuryTransport;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0); // deterministic backoff/jitter
  FakeWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  ({ WebexMercuryTransport } = await import("./websocket"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

function makeTransport() {
  const onPayload = vi.fn();
  const logs: string[] = [];
  const t = new WebexMercuryTransport(
    { token: "tok" } as never,
    "marcus",
    { onPayload, onLog: (_lvl, msg) => logs.push(msg) }
  );
  return { t, onPayload, logs };
}

describe("Mercury reconnect race (the daily-refresh double socket)", () => {
  it("a late close from the OLD socket must not open a second socket", async () => {
    const reg = deferrableFetch();
    const { t, onPayload } = makeTransport();

    // 1) initial connect
    const started = t.start();
    await flush();
    reg.release();
    await started;
    const s0 = FakeWebSocket.instances[0];
    s0.emit("open");
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 2) daily refresh: closes s0, arms reconnect (backoff 1000ms, jitter 0)
    (t as unknown as { scheduleReconnect(r: string): void }).scheduleReconnect("scheduled refresh");
    expect(s0.closed).toBe(true);

    // 3) reconnect timer fires -> connect() is now awaiting device registration
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(reg.held).toBe(1);

    // 4) THE RACE: s0's close event lands while registration is in flight.
    //    Old code: this.ws is undefined -> guard passes -> a 2nd reconnect is armed.
    s0.emit("close");

    // 5) registration completes -> s1 opens
    reg.release();
    await flush();
    const s1 = FakeWebSocket.instances[1];
    s1.emit("open");

    // 6) give any wrongly-armed reconnect every chance to fire
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    while (reg.held) {
      reg.release();
      await flush();
    }

    // Exactly two sockets ever existed (s0 then its replacement s1) — no s2.
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(s1.closed).toBe(false);

    // A message on the stale socket is dropped; on the live socket it is delivered once.
    s0.emit("message", { data: activityFrame("m-1") });
    s1.emit("message", { data: activityFrame("m-2") });
    await flush();
    expect(onPayload).toHaveBeenCalledTimes(1);
  });

  it("two overlapping connect() calls leave exactly one attached socket", async () => {
    const reg = deferrableFetch();
    const { t, logs } = makeTransport();
    const priv = t as unknown as { connect(): Promise<void> };

    const c1 = priv.connect();
    const c2 = priv.connect();
    await flush();
    expect(reg.held).toBe(2);

    reg.release(); // c1's registration finishes first...
    await flush();
    reg.release(); // ...then c2's
    await flush();
    await Promise.all([c1, c2]);

    // c1 was superseded during registration and must not have opened a socket.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(logs.some((l) => l.includes("superseded"))).toBe(true);
  });
});

describe("inbound dedup (belt and braces)", () => {
  it("drops a repeated Mercury activity id and logs it", async () => {
    const reg = deferrableFetch();
    const { t, onPayload, logs } = makeTransport();
    const started = t.start();
    await flush();
    reg.release();
    await started;
    const s0 = FakeWebSocket.instances[0];
    s0.emit("open");

    s0.emit("message", { data: activityFrame("dup-1") });
    s0.emit("message", { data: activityFrame("dup-1") });
    s0.emit("message", { data: activityFrame("other-2") });
    await flush();

    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(logs.filter((l) => l.includes("duplicate activity dup-1"))).toHaveLength(1);
  });
});
