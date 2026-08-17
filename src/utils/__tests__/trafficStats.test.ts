import { describe, expect, it } from "vitest";
import type { LoadRecord } from "@/types/cfsm";
import {
  buildTodayTrafficRecordSamples,
  summarizeTodayTrafficRecords,
} from "@/utils/trafficStats";

function record(time: string, overrides: Partial<LoadRecord> = {}): LoadRecord {
  return {
    cpu: 0,
    gpu: 0,
    ram: 0,
    ram_total: 0,
    swap: 0,
    swap_total: 0,
    load: 0,
    temp: 0,
    disk: 0,
    disk_total: 0,
    disk_read: null,
    disk_write: null,
    net_in: 0,
    net_out: 0,
    net_total_up: 0,
    net_total_down: 0,
    process: 0,
    connections: 0,
    connections_udp: 0,
    client: "node-a",
    time: Date.parse(time),
    ...overrides,
  };
}

const DAY_START = Date.parse("2026-07-16T00:00:00Z");
const DAY_END = Date.parse("2026-07-16T23:59:59Z");

describe("summarizeTodayTrafficRecords", () => {
  it("integrates speed samples over the gap to the previous sample", () => {
    // 两个间隔 60s 的采样点：1 MB/s 上行 → 每段 60 MB。
    const stat = summarizeTodayTrafficRecords(
      "node-a",
      [
        record("2026-07-16T00:00:00Z", { net_out: 1_000_000, net_in: 2_000_000 }),
        record("2026-07-16T00:01:00Z", { net_out: 1_000_000, net_in: 2_000_000 }),
        record("2026-07-16T00:02:00Z", { net_out: 1_000_000, net_in: 2_000_000 }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(stat.trafficUp).toBe(120_000_000);
    expect(stat.trafficDown).toBe(240_000_000);
    expect(stat.sampleCount).toBe(3);
    expect(stat.hasSamples).toBe(true);
  });

  it("uses the last pre-range sample only as a time baseline", () => {
    const stat = summarizeTodayTrafficRecords(
      "node-a",
      [
        record("2026-07-15T23:59:00Z", { net_out: 5_000_000 }),
        record("2026-07-16T00:00:00Z", { net_out: 1_000_000 }),
      ],
      DAY_START,
      DAY_END,
    );

    // 只有区间内那个点计入，且用的是它自己的速率（1 MB/s × 60s）。
    expect(stat.trafficUp).toBe(60_000_000);
    expect(stat.sampleCount).toBe(1);
  });

  it("caps the integration window so an offline gap cannot invent traffic", () => {
    const stat = summarizeTodayTrafficRecords(
      "node-a",
      [
        record("2026-07-16T00:00:00Z", { net_out: 1_000_000 }),
        // 掉线 3 小时后恢复：按 10 分钟上限计入，而不是 3 小时。
        record("2026-07-16T03:00:00Z", { net_out: 1_000_000 }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(stat.trafficUp).toBe(600_000_000);
  });

  it("integrates adjacent in-range samples trapezoidally (averages the two speeds)", () => {
    // 相邻两点速率不同：2 MB/s → 0，梯形取均值 1 MB/s × 60s = 60 MB；
    // 旧的矩形口径（取当前点速率）会算成 0×60 = 0。
    const stat = summarizeTodayTrafficRecords(
      "node-a",
      [
        record("2026-07-16T00:00:00Z", { net_out: 2_000_000 }),
        record("2026-07-16T00:01:00Z", { net_out: 0 }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(stat.trafficUp).toBe(60_000_000);
    expect(stat.peakUp).toBe(2_000_000);
  });

  it("clamps a lone outlier spike in the total but keeps the raw peak", () => {
    // 五个 1 MB/s + 一个 50 MB/s 毛刺：中位数 1 MB/s、上界 10 MB/s，毛刺按 10 MB/s 计入总量。
    // 前四段各 60 MB；末段梯形 (1 + 10)/2 × 60s = 330 MB；合计 570 MB。峰值仍报真实的 50 MB/s。
    const stat = summarizeTodayTrafficRecords(
      "node-a",
      [
        record("2026-07-16T00:00:00Z", { net_out: 1_000_000 }),
        record("2026-07-16T00:01:00Z", { net_out: 1_000_000 }),
        record("2026-07-16T00:02:00Z", { net_out: 1_000_000 }),
        record("2026-07-16T00:03:00Z", { net_out: 1_000_000 }),
        record("2026-07-16T00:04:00Z", { net_out: 1_000_000 }),
        record("2026-07-16T00:05:00Z", { net_out: 50_000_000 }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(stat.trafficUp).toBe(570_000_000);
    expect(stat.peakUp).toBe(50_000_000);
    expect(stat.peakUpAt).toBe(Date.parse("2026-07-16T00:05:00Z"));
  });

  it("keeps the timestamp of each direction peak", () => {
    const stat = summarizeTodayTrafficRecords(
      "node-a",
      [
        record("2026-07-16T00:00:00Z", { net_out: 10, net_in: 90 }),
        record("2026-07-16T00:05:00Z", { net_out: 80, net_in: 20 }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(stat.peakUp).toBe(80);
    expect(stat.peakUpAt).toBe(Date.parse("2026-07-16T00:05:00Z"));
    expect(stat.peakDown).toBe(90);
    expect(stat.peakDownAt).toBe(Date.parse("2026-07-16T00:00:00Z"));
  });

  it("reports no samples when the range is empty", () => {
    const stat = summarizeTodayTrafficRecords("node-a", [], DAY_START, DAY_END);

    expect(stat.hasSamples).toBe(false);
    expect(stat.trafficUp).toBe(0);
    expect(stat.trafficDown).toBe(0);
    expect(stat.peakUpAt).toBeNull();
  });

  it("ignores samples after the range end", () => {
    const stat = summarizeTodayTrafficRecords(
      "node-a",
      [
        record("2026-07-16T00:00:00Z", { net_out: 1_000_000 }),
        record("2026-07-17T00:30:00Z", { net_out: 9_000_000 }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(stat.peakUp).toBe(1_000_000);
  });
});

describe("buildTodayTrafficRecordSamples", () => {
  it("returns in-range rate samples newest first", () => {
    const samples = buildTodayTrafficRecordSamples(
      [
        record("2026-07-15T23:00:00Z", { net_out: 1, net_in: 2 }),
        record("2026-07-16T00:00:00Z", { net_out: 3, net_in: 4 }),
        record("2026-07-16T00:05:00Z", { net_out: 5, net_in: 6 }),
      ],
      DAY_START,
      DAY_END,
    );

    expect(samples).toEqual([
      { timeMs: Date.parse("2026-07-16T00:05:00Z"), up: 5, down: 6 },
      { timeMs: Date.parse("2026-07-16T00:00:00Z"), up: 3, down: 4 },
    ]);
  });

  it("clamps negative rates to zero", () => {
    const samples = buildTodayTrafficRecordSamples(
      [record("2026-07-16T00:00:00Z", { net_out: -5, net_in: -1 })],
      DAY_START,
      DAY_END,
    );

    expect(samples).toEqual([
      { timeMs: Date.parse("2026-07-16T00:00:00Z"), up: 0, down: 0 },
    ]);
  });
});
