import { describe, expect, it } from "vitest";
import {
  bucketPingLoss,
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
