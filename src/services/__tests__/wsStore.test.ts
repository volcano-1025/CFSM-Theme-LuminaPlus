import { describe, expect, it } from "vitest";
import { resolveTrafficTotal, resolveWsFlushWindowMs } from "@/services/wsStore";

// 像 resolveTrafficTotals 每个 tick 那样,把一串原始累计读数喂给 resolver:把上一个显示值
//(store 存在 node metrics 上)往后传。
function drive(readings: number[]): number[] {
  let previous = 0;
  return readings.map((raw) => {
    previous = resolveTrafficTotal(previous, raw);
    return previous;
  });
}

describe("resolveTrafficTotal", () => {
  it("passes the backend counter through unchanged while it climbs", () => {
    expect(drive([10, 20, 30])).toEqual([10, 20, 30]);
  });

  it("holds the previous value when a tick reports zero (missing/partial sample)", () => {
    // 读到 0 是 offline/heartbeat 帧或漏了 net_total_up/down 的 payload,不是真实流量。
    // 保持上一个值能避免闪烁到 0,也(这正是我们要防的回归)避免真实读数回来时重复抬高总量:
    // 概览以前每次 offline 抖动都会大致翻倍。
    expect(drive([50, 0, 51])).toEqual([50, 50, 51]);
  });

  it("stays stable across repeated zero readings", () => {
    expect(drive([50, 0, 0, 51, 0, 52])).toEqual([50, 50, 50, 51, 51, 52]);
  });

  it("follows a genuine counter reset down (reboot / billing-cycle rollover)", () => {
    // 后端计数器合理下降;我们如实透传,让概览和流量限额条跟随后端而不是停在虚高值。
    expect(drive([50, 5, 6])).toEqual([50, 5, 6]);
  });

  it("ignores a zero gap but still follows a later real reset", () => {
    // 50 → offline(0,保持)→ 重置后带一个小的真实计数回来。
    expect(drive([50, 0, 2, 3])).toEqual([50, 50, 2, 3]);
  });

  it("does not surface a value until a real reading arrives", () => {
    expect(drive([0, 0, 10])).toEqual([0, 0, 10]);
  });
});

describe("resolveWsFlushWindowMs", () => {
  it("falls back to the default window before an interval is measured", () => {
    // 间隔未知（0）+ 节点少：用偏大的默认窗口，压住刚连上时的快照/追帧突刺。
    expect(resolveWsFlushWindowMs(0, 5)).toBe(1_000);
  });

  it("tracks the measured report interval when volume is light", () => {
    // 上报约 1s 一次 → 每秒渲染一次就够，不快于数据变化频率就不会闪。
    expect(resolveWsFlushWindowMs(1_000, 5)).toBe(1_000);
  });

  it("widens the window for high node counts (render-budget floor)", () => {
    // 100 台 ÷ 每秒 200 个节点次 = 500ms 下限，超过实测的 200ms 间隔。
    expect(resolveWsFlushWindowMs(200, 100)).toBe(500);
  });

  it("clamps to the maximum so updates never feel stale", () => {
    expect(resolveWsFlushWindowMs(5_000, 10)).toBe(2_000);
  });

  it("clamps to the minimum so a very fast stream stays responsive", () => {
    expect(resolveWsFlushWindowMs(50, 1)).toBe(120);
  });
});
