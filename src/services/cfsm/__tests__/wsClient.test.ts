// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWsConnection, type WsSample } from "@/services/cfsm/wsClient";

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function connect(ids: string[]) {
  const batches: WsSample[][] = [];
  const availability: boolean[] = [];
  const connection = createWsConnection("https://status.example.com", ids, {
    onBatch: (samples) => batches.push(samples),
    onAvailabilityChange: (available) => availability.push(available),
  });
  return { connection, batches, availability, socket: () => FakeSocket.instances.at(-1)! };
}

describe("createWsConnection", () => {
  it("connects to the wss endpoint and subscribes after open", () => {
    const { socket } = connect(["node-a", "node-b"]);

    expect(socket().url).toBe("wss://status.example.com/api/ws?subscribe=all");
    socket().open();

    expect(JSON.parse(socket().sent[0]!)).toEqual({
      type: "subscribe",
      scope: "all",
      ids: ["node-a", "node-b"],
    });
  });

  it("reports availability only once the socket is open", () => {
    const { availability, socket } = connect(["node-a"]);

    expect(availability).toEqual([]);
    socket().open();
    expect(availability).toEqual([true]);
  });

  it("extracts samples from data, payload and metrics alike", () => {
    const { batches, socket } = connect(["node-a"]);
    socket().open();

    socket().emit({
      type: "batchUpdate",
      updates: [
        { serverId: "node-a", samples: [{ ts: 1, data: { cpu: 10 } }] },
        { serverId: "node-b", samples: [{ ts: 2, payload: { cpu: 20 } }] },
        { serverId: "node-c", samples: [{ ts: 3, metrics: { cpu: 30 } }] },
      ],
    });

    expect(batches[0]).toEqual([
      { serverId: "node-a", ts: 1, data: { cpu: 10 } },
      { serverId: "node-b", ts: 2, data: { cpu: 20 } },
      { serverId: "node-c", ts: 3, data: { cpu: 30 } },
    ]);
  });

  it("ignores non-batchUpdate frames", () => {
    const { batches, socket } = connect(["node-a"]);
    socket().open();

    socket().emit({ type: "hello", ts: 1, subscribed: "all" });
    socket().emit({ type: "pong", ts: 2 });

    expect(batches).toEqual([]);
  });

  it("drops ids the backend would reject instead of sending them", () => {
    const { socket } = connect(["node-a", "bad id!", "x".repeat(65)]);
    socket().open();

    expect(JSON.parse(socket().sent[0]!).ids).toEqual(["node-a"]);
  });

  it("caps the subscription at 500 ids", () => {
    const ids = Array.from({ length: 600 }, (_, index) => `node-${index}`);
    const { socket } = connect(ids);
    socket().open();

    expect(JSON.parse(socket().sent[0]!).ids).toHaveLength(500);
  });

  it("resends the subscription when the node list changes", () => {
    const { connection, socket } = connect(["node-a"]);
    socket().open();

    connection.updateIds(["node-a", "node-b"]);
    expect(JSON.parse(socket().sent.at(-1)!).ids).toEqual(["node-a", "node-b"]);

    // 内容相同则不重复发送。
    connection.updateIds(["node-a", "node-b"]);
    expect(socket().sent).toHaveLength(2);
  });

  it("sends a keepalive ping on the interval", () => {
    const { socket } = connect(["node-a"]);
    socket().open();
    socket().sent.length = 0;

    vi.advanceTimersByTime(30_000);

    expect(JSON.parse(socket().sent[0]!).type).toBe("ping");
  });

  it("reconnects with backoff after an unexpected close", () => {
    const { socket } = connect(["node-a"]);
    socket().open();
    socket().onclose?.({ code: 1006 });

    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("stops retrying when the server rejects the subscription (1008)", () => {
    const { availability, socket } = connect(["node-a"]);
    socket().open();
    socket().onclose?.({ code: 1008 });

    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(availability.at(-1)).toBe(false);
  });

  it("does not reconnect after an explicit close", () => {
    const { connection, socket } = connect(["node-a"]);
    socket().open();
    connection.close();

    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.instances).toHaveLength(1);
  });
});
