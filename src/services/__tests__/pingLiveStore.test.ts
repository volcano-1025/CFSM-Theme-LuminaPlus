// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPingHistorySnapshot,
  recordPingSample,
  resetPingLiveStore,
  retainPingNodes,
  seedPingHistory,
  subscribePingHistory,
  type PingLiveSample,
} from "@/services/pingLiveStore";
import { EMPTY_CARRIER_PING, type CarrierPingSnapshot } from "@/types/cfsm";

const NOW = Date.UTC(2026, 6, 17, 12, 0);

function ping(values: Partial<CarrierPingSnapshot>): CarrierPingSnapshot {
  return { ...EMPTY_CARRIER_PING, ...values };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  resetPingLiveStore();
});

afterEach(() => {
  vi.useRealTimers();
  resetPingLiveStore();
});

describe("recordPingSample", () => {
  it("appends one sample per report timestamp", () => {
    recordPingSample("node-a", NOW - 60_000, ping({ ct: 30 }));
    recordPingSample("node-a", NOW, ping({ ct: 32 }));

    const samples = getPingHistorySnapshot("node-a");
    expect(samples.map((sample) => sample.ping.ct)).toEqual([30, 32]);
  });

  it("throttles the 5s websocket batches that repeat the same reading", () => {
    // 探针 60 秒才测一次，推送却是 5 秒一批：重复值不该占满缓冲区。
    for (let i = 0; i < 12; i++) {
      recordPingSample("node-a", NOW + i * 5_000, ping({ ct: 30 }));
    }

    expect(getPingHistorySnapshot("node-a")).toHaveLength(2);
  });

  it("records a changed reading sooner than the idle throttle", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-a", NOW + 25_000, ping({ ct: 80 }));

    expect(getPingHistorySnapshot("node-a").map((s) => s.ping.ct)).toEqual([30, 80]);
  });

  it("still ignores a changed reading inside the same push batch", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-a", NOW + 5_000, ping({ ct: 80 }));

    expect(getPingHistorySnapshot("node-a")).toHaveLength(1);
  });

  it("keeps a full hour of samples at the default 60s report interval", () => {
    for (let i = 0; i < 60; i++) {
      recordPingSample("node-a", NOW + i * 60_000, ping({ ct: 30 }));
    }

    const samples = getPingHistorySnapshot("node-a");
    expect(samples).toHaveLength(60);
    // 首尾跨度覆盖整整一小时，图表 24 格能填满。
    expect(samples.at(-1)!.time - samples[0]!.time).toBe(59 * 60_000);
  });

  it("ignores repeats of the same report, so callers can call it every frame", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    const first = getPingHistorySnapshot("node-a");
    recordPingSample("node-a", NOW, ping({ ct: 30 }));

    expect(getPingHistorySnapshot("node-a")).toBe(first);
  });

  it("ignores out-of-order reports", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-a", NOW - 30_000, ping({ ct: 99 }));

    expect(getPingHistorySnapshot("node-a")).toHaveLength(1);
  });

  it("skips nodes with no carrier configured at all", () => {
    recordPingSample("node-a", NOW, EMPTY_CARRIER_PING);

    expect(getPingHistorySnapshot("node-a")).toEqual([]);
  });

  it("restores a whole hour of samples, not just the last few minutes", () => {
    for (let i = 0; i < 60; i++) {
      recordPingSample("node-a", NOW - (59 - i) * 60_000, ping({ ct: 30 + i }));
    }
    vi.advanceTimersByTime(20_000);

    resetPingLiveStore();
    const restored = getPingHistorySnapshot("node-a");

    expect(restored).toHaveLength(60);
    expect(restored.at(-1)!.time - restored[0]!.time).toBe(59 * 60_000);
  });

  it("drops samples that fall out of the one-hour window", () => {
    recordPingSample("node-a", NOW - 2 * 60 * 60_000, ping({ ct: 10 }));
    recordPingSample("node-a", NOW, ping({ ct: 20 }));

    expect(getPingHistorySnapshot("node-a").map((s) => s.ping.ct)).toEqual([20]);
  });

  it("caps the buffer instead of growing without bound", () => {
    for (let i = 0; i < 400; i++) {
      recordPingSample("node-a", NOW + i * 60_000, ping({ ct: i % 90 }));
    }

    expect(getPingHistorySnapshot("node-a").length).toBeLessThanOrEqual(96);
  });

  it("notifies subscribers of the affected node only", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    subscribePingHistory("node-a", onA);
    subscribePingHistory("node-b", onB);

    recordPingSample("node-a", NOW, ping({ ct: 30 }));

    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
  });
});

describe("persistence", () => {
  it("restores the buffer after a reload so the chart is not blank", () => {
    recordPingSample("node-a", NOW - 60_000, ping({ ct: 30, lossCt: 0 }));
    recordPingSample("node-a", NOW, ping({ ct: 31, lossCt: 5 }));
    // 防抖窗口到点后落盘。
    vi.advanceTimersByTime(20_000);

    resetPingLiveStore();
    const restored = getPingHistorySnapshot("node-a");

    expect(restored.map((sample) => sample.ping.ct)).toEqual([30, 31]);
    expect(restored.at(-1)?.ping.lossCt).toBe(5);
  });

  it("does not restore samples that have expired while away", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    vi.advanceTimersByTime(20_000);

    resetPingLiveStore();
    vi.setSystemTime(NOW + 3 * 60 * 60_000);

    expect(getPingHistorySnapshot("node-a")).toEqual([]);
  });

  it("survives a corrupted cache entry", () => {
    window.localStorage.setItem("cfsm-luminaplus:ping-live:v1", "{not json");
    resetPingLiveStore();

    expect(getPingHistorySnapshot("node-a")).toEqual([]);
  });
});

describe("seedPingHistory", () => {
  /** 后端窗口：30 个点、每 2 分钟一个，覆盖最近一小时。 */
  function backendWindow(): PingLiveSample[] {
    return Array.from({ length: 30 }, (_, index) => ({
      time: NOW - (29 - index) * 120_000,
      ping: ping({ ct: 30 + index, lossCt: 0 }),
    }));
  }

  it("fills a whole hour on the first load, without accumulating", () => {
    seedPingHistory("node-a", backendWindow());

    const samples = getPingHistorySnapshot("node-a");
    expect(samples).toHaveLength(30);
    expect(samples.at(-1)!.time - samples[0]!.time).toBe(29 * 120_000);
  });

  it("keeps live samples that are newer than the window", () => {
    seedPingHistory("node-a", backendWindow());
    recordPingSample("node-a", NOW + 60_000, ping({ ct: 99 }));
    // 下一次 /api/servers 返回同一个窗口时，不能把这个更新的点冲掉。
    seedPingHistory("node-a", backendWindow());

    const samples = getPingHistorySnapshot("node-a");
    expect(samples).toHaveLength(31);
    expect(samples.at(-1)?.ping.ct).toBe(99);
  });

  it("keeps locally accumulated samples that fill a hole in the window", () => {
    // 线上实测的窗口形状：2 分钟网格在约 35 分钟前就停了，末尾直接追加一个「当前」点，
    // 中间是空洞。浏览器攒下的样本正好覆盖那段，不能因为它们比窗口末点旧就被丢掉。
    const holeyWindow: PingLiveSample[] = [
      ...Array.from({ length: 12 }, (_, index) => ({
        time: NOW - 55 * 60_000 + index * 120_000,
        ping: ping({ ct: 30 + index, lossCt: 0 }),
      })),
      { time: NOW, ping: ping({ ct: 42, lossCt: 0 }) },
    ];
    // 空洞期间本地记下的点（例如上次开着页面时累积、并已持久化）。
    recordPingSample("node-a", NOW - 20 * 60_000, ping({ ct: 55 }));
    recordPingSample("node-a", NOW - 10 * 60_000, ping({ ct: 56 }));

    seedPingHistory("node-a", holeyWindow);

    const samples = getPingHistorySnapshot("node-a");
    const times = samples.map((sample) => sample.time);
    expect(times).toContain(NOW - 20 * 60_000);
    expect(times).toContain(NOW - 10 * 60_000);
    expect(samples).toHaveLength(15);
    // 仍按时间升序，且同一时刻以后端为准。
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(samples.at(-1)?.ping.ct).toBe(42);
  });

  it("does not notify subscribers when the window is unchanged", () => {
    seedPingHistory("node-a", backendWindow());
    const listener = vi.fn();
    subscribePingHistory("node-a", listener);

    seedPingHistory("node-a", backendWindow());

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies when the window advances", () => {
    seedPingHistory("node-a", backendWindow());
    const listener = vi.fn();
    subscribePingHistory("node-a", listener);

    seedPingHistory("node-a", [
      ...backendWindow().slice(1),
      { time: NOW + 120_000, ping: ping({ ct: 77 }) },
    ]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPingHistorySnapshot("node-a").at(-1)?.ping.ct).toBe(77);
  });

  it("ignores an empty window so an older backend keeps its accumulated data", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    seedPingHistory("node-a", []);

    expect(getPingHistorySnapshot("node-a")).toHaveLength(1);
  });

  it("drops window points that already fell out of the hour", () => {
    seedPingHistory("node-a", [
      { time: NOW - 3 * 60 * 60_000, ping: ping({ ct: 10 }) },
      { time: NOW, ping: ping({ ct: 20 }) },
    ]);

    expect(getPingHistorySnapshot("node-a").map((s) => s.ping.ct)).toEqual([20]);
  });
});

describe("retainPingNodes", () => {
  it("drops buffers for nodes that no longer exist", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-b", NOW, ping({ ct: 40 }));

    retainPingNodes(["node-a"]);

    expect(getPingHistorySnapshot("node-a")).toHaveLength(1);
    expect(getPingHistorySnapshot("node-b")).toEqual([]);
  });
});
