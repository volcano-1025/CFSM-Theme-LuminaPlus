// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CfsmServerSchema, EMPTY_CARRIER_PING } from "@/types/cfsm";

/**
 * 实时连接的暂停与恢复：页面进后台（后端文档要求隐藏时断开）与站长设的连接时限
 * （`frontend_ws_timeout_minutes`）。两者都直接关系到站长的额度 —— 有前端 WebSocket 连着，
 * 后端就让全站探针 2 秒一报 —— 所以用假时钟把「什么时候断、什么时候才重连」钉住。
 * 同一套假时钟也钉着快照同步的失败退避与多站部分失败（文件末尾「快照同步」）。
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
  /** false 时新建的连接一直停在握手中，不回报可用。 */
  autoOpen: true,
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
    if (mocks.autoOpen) {
      queueMicrotask(() => {
        if (!connection.closed) handlers.onAvailabilityChange(true);
      });
    }
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

function snapshot(ids: string[] = ["node-a"], base = "https://backend.example") {
  return {
    servers: ids.map((id) => CfsmServerSchema.parse({ id, name: id, last_updated: Date.now() })),
    baseByServerId: new Map(ids.map((id) => [id, base] as const)),
    sysConfig: {},
    regionStats: {},
    stats: {},
    partial: false,
    failedBases: [] as string[],
  };
}

// store 有模块级状态，每条用例重新求值一份。
async function loadStore() {
  vi.resetModules();
  return import("@/services/wsStore");
}

const syncCount = () => mocks.getServersSnapshot.mock.calls.length;
const nodeIds = (store: Awaited<ReturnType<typeof loadStore>>) =>
  store.getAllNodeMetaSnapshot().map((node) => node.uuid);

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  mocks.autoOpen = true;
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

    // 切回前台：重建连接，并补一次快照。
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCount()).toBe(syncsBeforeReturn + 1);
    expect(mocks.connections).toHaveLength(2);
    expect(mocks.connections[1]!.closed).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reconnects on return without waiting for the snapshot", async () => {
    const store = await loadStore();
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(store.HIDDEN_REALTIME_PAUSE_DELAY_MS);
    expect(mocks.connections[0]!.closed).toBe(true);

    // 冷的 /api/servers 要好几秒（线上实测 2~8 秒），而探针要等订阅到了才从 60 秒一报提速：
    // 连接排在快照后面，切回来就一直是旧数据。
    let resolveSnapshot!: (value: ReturnType<typeof snapshot>) => void;
    mocks.getServersSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    setHidden(false);
    expect(mocks.connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getStoreStatusSnapshot().realtimeConnected).toBe(true);

    // 快照回来多了一台节点：在同一条连接上改订阅，不再重连。
    resolveSnapshot(snapshot(["node-a", "node-b"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.connections).toHaveLength(2);
    expect(mocks.connections[1]!.ids).toEqual(["node-a", "node-b"]);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("ignores the snapshot's stale rate while the new connection is still handshaking", async () => {
    const serverAt = (netInSpeed: number, lastUpdated: number) => ({
      ...snapshot(),
      servers: [
        CfsmServerSchema.parse({
          id: "node-a",
          name: "node-a",
          last_updated: lastUpdated,
          net_in_speed: netInSpeed,
        }),
      ],
    });
    mocks.getServersSnapshot.mockImplementation(async () => serverAt(100, Date.now()));
    const store = await loadStore();
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getNodeMetricsSnapshot("node-a")?.netDown).toBe(100);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    // 切回前台时连接还没握上手，快照先回来：它的速率是 30 秒前的，不能当现在显示。
    mocks.autoOpen = false;
    mocks.getServersSnapshot.mockImplementation(async () => serverAt(9_999, Date.now() - 30_000));
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getNodeMetricsSnapshot("node-a")?.netDown).toBe(100);

    // 这次打开页面连上过，重连慢只是后端冷启动：5 秒还不算连不上（原来 5 秒就采用，线上被顶到 5.93 MB/s）。
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getNodeMetricsSnapshot("node-a")?.netDown).toBe(100);

    // 过了重连宽限期还是连不上，就是真连不上：轮询兜底时快照是唯一的数据源，照用。
    await vi.advanceTimersByTimeAsync(store.WS_RECONNECT_GRACE_MS);
    expect(store.getNodeMetricsSnapshot("node-a")?.netDown).toBe(9_999);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not poll the cached snapshot every 5 seconds while a known-good connection is reconnecting", async () => {
    const store = await loadStore();
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(store.HIDDEN_REALTIME_PAUSE_DELAY_MS);
    mocks.autoOpen = false;
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    const afterResume = syncCount();

    // 宽限期内只有切回来时补的那一次。
    await vi.advanceTimersByTimeAsync(store.WS_RECONNECT_GRACE_MS - 1_000);
    expect(syncCount()).toBe(afterResume);

    // 过了宽限期还没连上，退回 5 秒轮询兜底。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(syncCount()).toBeGreaterThan(afterResume);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("still falls back after 5 seconds on a site whose realtime never connected", async () => {
    mocks.autoOpen = false;
    const store = await loadStore();
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);
    const afterBootstrap = syncCount();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(syncCount()).toBeGreaterThan(afterBootstrap);

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

  it("keeps the socket open when the focused node is not in the snapshot", async () => {
    mocks.getServersSnapshot.mockImplementation(async () => snapshot(["node-a", "node-b"]));
    const store = await loadStore();
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);

    // 地址里的 ID 已经删掉 / 访客打开了后台隐藏的节点：按焦点过滤会一台不剩。
    const leave = store.focusRealtimeNode("node-gone");
    expect(mocks.connections[0]!.closed).toBe(false);
    expect(mocks.connections[0]!.ids).toEqual(["node-a", "node-b"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.connections[0]!.closed).toBe(false);

    leave();
    expect(mocks.connections).toHaveLength(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("快照同步", () => {
  it("backs off once per failed sync, even when a poll tick joined it", async () => {
    const startedAt = Date.now();
    const callTimes: number[] = [];
    mocks.getServersSnapshot.mockImplementation(() => {
      callTimes.push(Date.now() - startedAt);
      // 冷的 /api/servers 拖到 8 秒超时才失败：比 5 秒一拍的轮询长，途中那一拍会接上同一个请求。
      return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8_000));
    });
    const store = await loadStore();
    const release = store.retainStore();

    await vi.advanceTimersByTimeAsync(19_000);
    // 第 8 秒失败 → 退避一拍（跳过第 10 秒）→ 第 15 秒重试。退避算了两次的话要拖到第 20 秒。
    expect(callTimes).toEqual([0, 15_000]);

    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("keeps a site's nodes, socket and ping buffer when only that site misses a sync", async () => {
    const siteA = "https://a.example";
    const siteB = "https://b.example";
    const bothSites = () => {
      const a = snapshot(["node-a"], siteA);
      const b = snapshot(["node-b"], siteB);
      return {
        ...a,
        servers: [...a.servers, ...b.servers],
        baseByServerId: new Map([...a.baseByServerId, ...b.baseByServerId]),
      };
    };
    mocks.getServersSnapshot.mockImplementation(async () => bothSites());
    const store = await loadStore();
    const pingLive = await import("@/services/pingLiveStore");
    const release = store.retainStore();
    await vi.advanceTimersByTimeAsync(0);
    expect(nodeIds(store)).toEqual(["node-a", "node-b"]);
    expect(mocks.connections).toHaveLength(2);
    pingLive.recordPingSample("node-b", Date.now(), { ...EMPTY_CARRIER_PING, ct: 42 });

    // B 站这一轮超时：快照里只剩 A 站的节点。
    mocks.getServersSnapshot.mockImplementation(async () => ({
      ...snapshot(["node-a"], siteA),
      partial: true,
      failedBases: [siteB],
    }));
    const syncs = syncCount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncCount()).toBe(syncs + 1);
    expect(nodeIds(store)).toEqual(["node-a", "node-b"]);
    expect(mocks.connections.map((connection) => connection.closed)).toEqual([false, false]);
    expect(pingLive.getPingHistorySnapshot("node-b")).toHaveLength(1);
    expect(store.getStoreStatusSnapshot().partial).toBe(true);

    // B 站恢复响应、节点确实删了：这一次才去掉。
    mocks.getServersSnapshot.mockImplementation(async () => snapshot(["node-a"], siteA));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(nodeIds(store)).toEqual(["node-a"]);
    expect(mocks.connections.map((connection) => connection.closed)).toEqual([false, true]);

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
