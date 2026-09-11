// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CfsmServerSchema } from "@/types/cfsm";

/**
 * 实时连接的暂停与恢复：页面进后台（后端文档要求隐藏时断开）与站长设的连接时限
 * （`frontend_ws_timeout_minutes`）。两者都直接关系到站长的额度 —— 有前端 WebSocket 连着，
 * 后端就让全站探针 2 秒一报 —— 所以用假时钟把「什么时候断、什么时候才重连」钉住。
 */

interface FakeConnection {
  ids: string[];
  closed: boolean;
  close(): void;
  updateIds(ids: string[]): void;
}

const mocks = vi.hoisted(() => ({
  connections: [] as FakeConnection[],
  getServersSnapshot: vi.fn(),
}));

vi.mock("@/services/cfsm/wsClient", () => ({
  createWsConnection: (
    _base: string,
    ids: string[],
    handlers: { onAvailabilityChange(available: boolean): void },
  ) => {
    const connection: FakeConnection = {
      ids: [...ids],
      closed: false,
      close() {
        connection.closed = true;
      },
      updateIds(next) {
        connection.ids = [...next];
      },
    };
    mocks.connections.push(connection);
    queueMicrotask(() => {
      if (!connection.closed) handlers.onAvailabilityChange(true);
    });
    return connection;
  },
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getServersSnapshot: (...args: unknown[]) => mocks.getServersSnapshot(...args),
  };
});

let hidden = false;
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

function setHidden(next: boolean) {
  hidden = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function snapshot(ids: string[] = ["node-a"]) {
  return {
    servers: ids.map((id) => CfsmServerSchema.parse({ id, name: id, last_updated: Date.now() })),
    baseByServerId: new Map(ids.map((id) => [id, "https://backend.example"] as const)),
    sysConfig: {},
    regionStats: {},
    stats: {},
    partial: false,
  };
}

// store 有模块级状态，每条用例重新求值一份。
async function loadStore() {
  vi.resetModules();
  return import("@/services/wsStore");
}

const syncCount = () => mocks.getServersSnapshot.mock.calls.length;

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  mocks.connections.length = 0;
  mocks.getServersSnapshot.mockReset();
  mocks.getServersSnapshot.mockImplementation(async () => snapshot());
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("页面进后台", () => {
  it("disconnects after the grace period, stops polling, and resyncs once on return", async () => {
    const store = await loadStore();
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.connections).toHaveLength(1);
    expect(store.getStoreStatusSnapshot().realtimeConnected).toBe(true);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(store.HIDDEN_REALTIME_PAUSE_DELAY_MS - 1);
    expect(mocks.connections[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.connections[0]!.closed).toBe(true);
    expect(store.getStoreStatusSnapshot().realtimeConnected).toBe(false);

    // 后台期间既不重连也不轮询（WS 断了本来会退回 5 秒轮询）。
    const syncsBeforeReturn = syncCount();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(syncCount()).toBe(syncsBeforeReturn);
    expect(mocks.connections).toHaveLength(1);

    // 切回前台：先补一次快照，再重建连接。
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCount()).toBe(syncsBeforeReturn + 1);
    expect(mocks.connections).toHaveLength(2);
    expect(mocks.connections[1]!.closed).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("leaves the connection alone for a quick tab switch inside the grace period", async () => {
    const store = await loadStore();
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);
    const syncs = syncCount();

    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(store.HIDDEN_REALTIME_PAUSE_DELAY_MS);

    expect(mocks.connections).toHaveLength(1);
    expect(mocks.connections[0]!.closed).toBe(false);
    expect(syncCount()).toBe(syncs);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("实时连接时限（frontend_ws_timeout_minutes）", () => {
  it("disconnects at the limit and stays paused, even across a tab switch, until the user continues", async () => {
    const store = await loadStore();
    store.setRealtimeSessionLimitMinutes(1);
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.connections).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.connections[0]!.closed).toBe(true);
    expect(store.getStoreStatusSnapshot().realtimeSessionExpired).toBe(true);

    // 到时限后：不轮询、不重连，切到后台再切回来也不会静默重连。
    const syncs = syncCount();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(store.HIDDEN_REALTIME_PAUSE_DELAY_MS + 1_000);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(mocks.connections).toHaveLength(1);
    expect(syncCount()).toBe(syncs);

    // 用户点「继续」：补一次快照、重连，并重新计时。
    store.resumeRealtimeSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getStoreStatusSnapshot().realtimeSessionExpired).toBe(false);
    expect(syncCount()).toBe(syncs + 1);
    expect(mocks.connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.connections[1]!.closed).toBe(true);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does nothing when the site sets no limit", async () => {
    const store = await loadStore();
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(mocks.connections[0]!.closed).toBe(false);
    expect(store.getStoreStatusSnapshot().realtimeSessionExpired).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("详情页只订阅正在看的这一台", () => {
  it("narrows the subscription on the same socket and restores everyone on leave", async () => {
    mocks.getServersSnapshot.mockImplementation(async () => snapshot(["node-a", "node-b"]));
    const store = await loadStore();
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.connections[0]!.ids).toEqual(["node-a", "node-b"]);

    const leave = store.focusRealtimeNode("node-b");
    expect(mocks.connections[0]!.ids).toEqual(["node-b"]);
    // 60 秒一次的全量同步不会把别的节点加回来。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.connections[0]!.ids).toEqual(["node-b"]);

    leave();
    expect(mocks.connections[0]!.ids).toEqual(["node-a", "node-b"]);
    // 全程同一条连接：没有重连，连接时限的计时也不会被进出详情页重置。
    expect(mocks.connections).toHaveLength(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("resolveRealtimeSessionLimitMs", () => {
  it("treats 0, negatives, fractions and junk as no limit", async () => {
    const { resolveRealtimeSessionLimitMs } = await loadStore();
    for (const value of [0, -5, 1.5, "abc", null, undefined]) {
      expect(resolveRealtimeSessionLimitMs(value)).toBe(0);
    }
  });

  it("converts minutes and caps at the backend's 1440", async () => {
    const { resolveRealtimeSessionLimitMs } = await loadStore();
    expect(resolveRealtimeSessionLimitMs(20)).toBe(20 * 60_000);
    expect(resolveRealtimeSessionLimitMs("30")).toBe(30 * 60_000);
    expect(resolveRealtimeSessionLimitMs(5000)).toBe(1440 * 60_000);
  });
});
