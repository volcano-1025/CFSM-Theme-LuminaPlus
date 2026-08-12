// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPingHistorySnapshot,
  recordPingSample,
  resetPingLiveStore,
  retainPingNodes,
  subscribePingHistory,
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

  it("drops samples that fall out of the one-hour window", () => {
    recordPingSample("node-a", NOW - 2 * 60 * 60_000, ping({ ct: 10 }));
    recordPingSample("node-a", NOW, ping({ ct: 20 }));

    expect(getPingHistorySnapshot("node-a").map((s) => s.ping.ct)).toEqual([20]);
  });

  it("caps the buffer instead of growing without bound", () => {
    for (let i = 0; i < 120; i++) {
      recordPingSample("node-a", NOW - (120 - i) * 1000, ping({ ct: i }));
    }

    expect(getPingHistorySnapshot("node-a").length).toBeLessThanOrEqual(64);
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

describe("retainPingNodes", () => {
  it("drops buffers for nodes that no longer exist", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-b", NOW, ping({ ct: 40 }));

    retainPingNodes(["node-a"]);

    expect(getPingHistorySnapshot("node-a")).toHaveLength(1);
    expect(getPingHistorySnapshot("node-b")).toEqual([]);
  });
});
