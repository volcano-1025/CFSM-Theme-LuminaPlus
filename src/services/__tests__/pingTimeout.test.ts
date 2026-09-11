// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPingBuckets, buildPingOverviewItem } from "@/hooks/usePingOverview";
import { PING_TIMEOUT_VALUE } from "@/services/cfsm/mappers";
import {
  getPingHistorySnapshot,
  recordPingSample,
  resetPingLiveStore,
  seedPingHistory,
  type PingLiveSample,
} from "@/services/pingLiveStore";
import { EMPTY_CARRIER_PING, type CarrierPingSnapshot } from "@/types/cfsm";

/**
 * 整轮超时（后端 `ping: null` + `loss: 100`，读进来是 PING_TIMEOUT_VALUE）在首页链路上的表现。
 * 这之前超时被读成「没数据」：缓冲区不收、柱子留空、卡片丢包率不算它。
 */

const NOW = Date.UTC(2026, 8, 11, 12, 0);
const MINUTE = 60_000;
const TIMEOUT = { ct: PING_TIMEOUT_VALUE, lossCt: 100 };

function ping(values: Partial<CarrierPingSnapshot>): CarrierPingSnapshot {
  return { ...EMPTY_CARRIER_PING, ...values };
}

function sample(minutesAgo: number, values: Partial<CarrierPingSnapshot>): PingLiveSample {
  return { time: NOW - minutesAgo * MINUTE, ping: ping(values) };
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

describe("整轮超时", () => {
  it("counts toward the card's loss rate instead of being skipped", () => {
    const item = buildPingOverviewItem("node-a", 1, [
      sample(18, { ct: 30, lossCt: 0 }),
      sample(12, TIMEOUT),
      sample(6, { ct: 32, lossCt: 0 }),
    ]);

    expect(item.loss).toBeCloseTo(100 / 3, 5);
    // 「当前延迟」仍是最近一次成功的值，不会显示成 -1。
    expect(item.lastValue).toBe(32);
    expect(item.emptyTimes).toEqual([]);
  });

  it("paints its bucket as 100% loss rather than leaving it empty", () => {
    const item = buildPingOverviewItem("node-a", 1, [
      sample(10, { ct: 30, lossCt: 0 }),
      sample(5, TIMEOUT),
    ]);
    const buckets = buildPingBuckets(item, 20, NOW, null, 30 * MINUTE);
    const last = buckets[buckets.length - 1]!;

    expect(last.loss).toBe(100);
    expect(last.value).toBeNull();
  });

  it("lands in the live buffer even when every line timed out at once", () => {
    recordPingSample("node-a", NOW - MINUTE, ping({ ct: 30, lossCt: 0 }));
    recordPingSample("node-a", NOW, ping(TIMEOUT));

    expect(getPingHistorySnapshot("node-a").map((entry) => entry.ping.ct)).toEqual([
      30,
      PING_TIMEOUT_VALUE,
    ]);
  });

  it("survives the copied-run filter: a sustained outage is real, not a backend copy", () => {
    // 新后端每格都是真实采样；连着 5 格整轮超时是真断网，逐字节相同也不是复印件。
    seedPingHistory(
      "node-a",
      [25, 19, 13, 7, 1].map((minutesAgo) => sample(minutesAgo, TIMEOUT)),
    );

    expect(getPingHistorySnapshot("node-a")).toHaveLength(5);
  });
});
