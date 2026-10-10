import { describe, expect, it } from "vitest";
import {
  bucketPingLoss,
  resolveLossCellSpans,
  formatPingTooltipValue,
  resolvePingSampleCounts,
} from "@/utils/pingMetrics";

describe("formatPingTooltipValue", () => {
  it("hides a zero loss and keeps the latency alone", () => {
    expect(formatPingTooltipValue(42.35, 0)).toBe("42.4 ms");
    expect(formatPingTooltipValue(42.35, null)).toBe("42.4 ms");
  });

  it("puts the loss first so the latency stays in the right-aligned column", () => {
    expect(formatPingTooltipValue(42, 12.4)).toBe("丢包 12% · 42.0 ms");
    // 不足 1% 取整会变成 0%，看起来像没丢包，所以保留一位小数。
    expect(formatPingTooltipValue(42, 0.4)).toBe("丢包 0.4% · 42.0 ms");
  });

  it("reports loss alone when the sample timed out", () => {
    expect(formatPingTooltipValue(null, 100)).toBe("丢包 100%");
    expect(formatPingTooltipValue(null, 0)).toBe("—");
    expect(formatPingTooltipValue(null, null)).toBe("—");
  });
});

describe("bucketPingLoss", () => {
  it("averages by sample count instead of taking the bucket peak", () => {
    // 同一格里 3 次成功 + 1 次全丢 = 25%，而不是被那次 100% 染红整格。
    const loss = bucketPingLoss(
      [
        { time: 100, lost: 0, total: 1 },
        { time: 101, lost: 0, total: 1 },
        { time: 102, lost: 1, total: 1 },
        { time: 103, lost: 0, total: 1 },
      ],
      [100],
    );
    expect(loss).toEqual([25]);
  });

  it("keeps buckets without samples as null so gaps stay distinguishable from 0%", () => {
    const loss = bucketPingLoss([{ time: 0, lost: 0, total: 1 }], [0, 60, 120]);
    expect(loss).toEqual([0, null, null]);
  });

  it("assigns each sample to the nearest target time", () => {
    const loss = bucketPingLoss(
      [
        { time: 25, lost: 1, total: 1 },
        { time: 95, lost: 0, total: 1 },
      ],
      [0, 100],
    );
    expect(loss).toEqual([100, 0]);
  });

  it("returns all-null for an empty input", () => {
    expect(bucketPingLoss([], [0, 60])).toEqual([null, null]);
    expect(bucketPingLoss([{ time: 0, lost: 0, total: 1 }], [])).toEqual([]);
  });

  it("carries partial loss percentages through unrounded", () => {
    // resolvePingSampleCounts 把「一次采样丢 33%」保留成小数，聚合后不该被抹成 0 或 100。
    const counts = resolvePingSampleCounts({ value: 42, count: 1, loss: 33 });
    expect(bucketPingLoss([{ time: 0, ...counts }], [0])).toEqual([33]);
  });
});

describe("resolveLossCellSpans", () => {
  it("meets neighbours at the midpoint so the strip has no seams", () => {
    expect(resolveLossCellSpans([0, 60, 120], [0, 10, 0])).toEqual([
      [-30, 30],
      [30, 90],
      [90, 150],
    ]);
  });

  it("does not paint back into an outage", () => {
    // 站长 2026-10-10 的 Fachost-tw：18:16:35 之后断了 140 分钟，20:36:54 恢复；中间是折线的断点哨兵（没有丢包值）。
    const lastBefore = 0;
    const sentinel = 90;
    const firstAfter = 140 * 60;
    const times = [-180, -90, lastBefore, sentinel, firstAfter, firstAfter + 90, firstAfter + 180];
    const spans = resolveLossCellSpans(times, [0, 0, 33, null, 0, 0, 16]);

    expect(spans[3]).toBeNull();
    // 断档前最后一格、断档后第一格，朝断档那一侧都只占半个点距（45 秒），不是涂到中点。
    expect(spans[2]).toEqual([-45, 45]);
    expect(spans[4]).toEqual([firstAfter - 45, firstAfter + 45]);
  });

  it("keeps a lone sample narrow", () => {
    expect(resolveLossCellSpans([100], [50])).toEqual([[100, 100]]);
    expect(resolveLossCellSpans([0, 60, 4000], [null, null, 5])).toEqual([null, null, [3970, 4030]]);
  });
});
