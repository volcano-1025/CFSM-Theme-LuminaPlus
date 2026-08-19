// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPingHealth } from "@/hooks/usePingDataHealth";
import {
  recordPingSample,
  resetPingLiveStore,
  seedPingHistory,
  type PingLiveSample,
} from "@/services/pingLiveStore";
import { shouldPromptPingRefresh, summarizePingHealth } from "@/utils/pingWindowHealth";
import { EMPTY_CARRIER_PING, type CarrierPingSnapshot } from "@/types/cfsm";

const NOW = Date.UTC(2026, 7, 19, 12, 0);
const STEP = 120_000;

function ping(values: Partial<CarrierPingSnapshot>): CarrierPingSnapshot {
  return { ...EMPTY_CARRIER_PING, ...values };
}

/** 后端那份 30 格窗口，`value(index)` 给这一格的延迟。丢包一律 0（正常探测就是这样）。 */
function windowOf(value: (index: number) => number): PingLiveSample[] {
  return Array.from({ length: 30 }, (_, index) => ({
    time: NOW - (29 - index) * STEP,
    ping: ping({ ct: value(index), cu: value(index) + 10, cm: value(index) + 20, lossCt: 0 }),
  }));
}

const singleLine = () => [1];

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

describe("打开页面时的延迟数据自检", () => {
  it("正常波动的窗口：一台都不报", () => {
    seedPingHistory("good", windowOf((index) => 120 + (index % 7)));

    const results = collectPingHealth(["good"], singleLine, NOW);

    expect(results[0]?.suspect).toBe(false);
    expect(shouldPromptPingRefresh(summarizePingHealth(results))).toBe(false);
  });

  it("整窗口都是复印件的新节点：报出来，两条理由都占", () => {
    // 线上 Uzumaru-tw 的形状：30 格全是同一个值，历史表里只有几分钟。
    seedPingHistory("fresh", windowOf(() => 1));

    const results = collectPingHealth(["fresh"], singleLine, NOW);

    expect(results[0]?.suspect).toBe(true);
    expect(results[0]?.reasons).toEqual(["gap", "backfilled"]);
  });

  it("复印段被丢掉、柱子空掉大半：报「空缺」", () => {
    // 前 24 格是复印件（会被丢掉），末尾 6 格是真值。
    seedPingHistory("mostly-copied", windowOf((index) => (index < 24 ? 1 : 130 + index)));

    const results = collectPingHealth(["mostly-copied"], singleLine, NOW);

    expect(results[0]?.suspect).toBe(true);
    expect(results[0]?.reasons).toContain("gap");
    expect(results[0]?.gapRatio).toBeGreaterThan(0.5);
  });

  it("后端不探测这台（既没窗口也没样本）就不判，免得每次打开都白问一遍", () => {
    const results = collectPingHealth(["unprobed"], singleLine, NOW);

    expect(results[0]).toBeNull();
    expect(shouldPromptPingRefresh(summarizePingHealth(results))).toBe(false);
  });

  it("窗口是编的、但本地实测已经把这一小时铺满：不报", () => {
    // 页面开着攒了一小时真样本，柱子是满的 —— 这时候再让用户花一次 D1 没有意义。
    seedPingHistory("covered", windowOf(() => 1));
    for (let index = 0; index <= 60; index += 1) {
      recordPingSample("covered", NOW - (60 - index) * 60_000, ping({ ct: 120 + (index % 5) }));
    }

    const results = collectPingHealth(["covered"], singleLine, NOW);

    expect(results[0]?.suspect).toBe(false);
  });

  it("多线路模式下取最完整的那条：某条任务没跑不算这台有问题", () => {
    // 只有电信有数据，联通/移动这两条任务后端根本没配。
    seedPingHistory(
      "single-line-only",
      Array.from({ length: 30 }, (_, index) => ({
        time: NOW - (29 - index) * STEP,
        ping: ping({ ct: 120 + (index % 7), lossCt: 0 }),
      })),
    );

    const results = collectPingHealth(["single-line-only"], () => [1, 2, 3], NOW);

    expect(results[0]?.suspect).toBe(false);
  });
});
