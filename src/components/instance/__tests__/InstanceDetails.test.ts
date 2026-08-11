import { describe, expect, it } from "vitest";
import {
  formatTodayPeakValue,
  formatTodayTrafficValue,
} from "@/components/instance/instanceTodayTrafficFormat";
import type { TodayTrafficStat } from "@/utils/trafficStats";

const stat: TodayTrafficStat = {
  uuid: "node-a",
  trafficUp: 1024,
  trafficDown: 2048,
  peakUp: 0,
  peakUpAt: null,
  peakDown: 0,
  peakDownAt: null,
  sampleCount: 1,
  hasSamples: true,
};

describe("InstanceDetails today traffic status", () => {
  it("reports a total query failure instead of normal no-sample state", () => {
    expect(formatTodayTrafficValue(undefined, false, true)).toBe("今日流量加载失败");
  });

  it("keeps stale data visible and marks a failed refresh", () => {
    expect(formatTodayTrafficValue(stat, false, true)).toContain("更新失败");
    expect(formatTodayTrafficValue(stat, false, true)).toContain("1.00 KB");
  });

  it("does not hide a failed refresh behind an empty cached result", () => {
    const emptyStat = { ...stat, hasSamples: false, sampleCount: 0 };
    expect(formatTodayTrafficValue(emptyStat, false, true)).toBe(
      "今日暂无采样（更新失败）",
    );
  });

  it("hides peak timestamps when the peak rate is zero", () => {
    const zeroPeakWithLegacyTime = {
      ...stat,
      peakUpAt: Date.parse("2026-08-07T00:05:00+08:00"),
      peakDownAt: Date.parse("2026-08-07T00:05:00+08:00"),
    };

    expect(formatTodayPeakValue(zeroPeakWithLegacyTime, false)).toBe(
      "↑ 0 B/s · ↓ 0 B/s",
    );
  });
});
