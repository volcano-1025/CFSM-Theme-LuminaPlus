import { describe, expect, it } from "vitest";
import { resolveTrafficTotal, resolveWsNodeIntervalMs } from "@/services/wsStore";

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

describe("resolveWsNodeIntervalMs", () => {
  it("shows one frame per arrival when a node sends one at a time", () => {
    // 2 秒来 1 帧：放完队列就空 → 下一帧在 2 秒后，即 2 秒更新一次。
    expect(resolveWsNodeIntervalMs(2_000, 0)).toBe(2_000);
  });

  it("splits the arrival gap when a node sends two frames at once", () => {
    // 2 秒来 2 帧：放掉一帧还剩一帧 → 1 秒后放第二帧，正好在下次到达前铺完。
    expect(resolveWsNodeIntervalMs(2_000, 1)).toBe(1_000);
  });

  it("paces a faster node by its own cadence, independent of others", () => {
    // 约 1.1 秒来 1 帧的节点按自己的节奏走，不被别人的 2 秒拖慢。
    expect(resolveWsNodeIntervalMs(1_100, 0)).toBe(1_100);
  });

  it("spreads a burst of frames evenly across the arrival gap", () => {
    expect(resolveWsNodeIntervalMs(4_000, 3)).toBe(1_000);
  });

  it("falls back to the default cadence before one is measured", () => {
    expect(resolveWsNodeIntervalMs(0, 0)).toBe(1_000);
  });

  it("clamps so playback never storms or stalls", () => {
    expect(resolveWsNodeIntervalMs(1_000, 20)).toBe(200);
    expect(resolveWsNodeIntervalMs(15_000, 0)).toBe(3_000);
  });
});
