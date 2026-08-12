import { describe, expect, it } from "vitest";
import {
  buildPingBuckets,
  buildPingOverviewItem,
  resolveHomepagePingRequestMode,
} from "@/hooks/usePingOverview";
import type { PingLiveSample } from "@/services/pingLiveStore";
import { EMPTY_CARRIER_PING } from "@/types/cfsm";

const MINUTE_MS = 60_000;
const NOW = Date.UTC(2026, 6, 17, 11, 2);

function sample(
  minutesAgo: number,
  values: Partial<PingLiveSample["ping"]>,
): PingLiveSample {
  return {
    time: NOW - minutesAgo * MINUTE_MS,
    ping: { ...EMPTY_CARRIER_PING, ...values },
  };
}

describe("buildPingOverviewItem", () => {
  it("picks the carrier that matches the task id", () => {
    const samples = [sample(2, { ct: 30, cu: 60, cm: 90, bd: 20 })];

    expect(buildPingOverviewItem("node-a", 1, samples).lastValue).toBe(30);
    expect(buildPingOverviewItem("node-a", 2, samples).lastValue).toBe(60);
    expect(buildPingOverviewItem("node-a", 3, samples).lastValue).toBe(90);
    expect(buildPingOverviewItem("node-a", 4, samples).lastValue).toBe(20);
  });

  it("carries the per-sample loss through and reports the latest one", () => {
    const item = buildPingOverviewItem("node-a", 1, [
      sample(3, { ct: 30, lossCt: 0 }),
      sample(1, { ct: 40, lossCt: 25 }),
    ]);

    expect(item.samples.map((entry) => entry.loss)).toEqual([0, 25]);
    expect(item.loss).toBe(25);
  });

  it("skips samples where the carrier has no measurement", () => {
    const item = buildPingOverviewItem("node-a", 2, [
      sample(3, { ct: 30 }),
      sample(2, { ct: 31, cu: 55 }),
    ]);

    expect(item.samples).toHaveLength(1);
    expect(item.samples[0]?.value).toBe(55);
  });

  it("tracks the maximum for chart scaling", () => {
    const item = buildPingOverviewItem("node-a", 1, [
      sample(3, { ct: 30 }),
      sample(2, { ct: 120 }),
      sample(1, { ct: 40 }),
    ]);

    expect(item.max).toBe(120);
  });

  it("is not assigned while the carrier has no measurement at all", () => {
    // 没有实测值时卡片不该画空柱子，也让"模拟延迟"设置有机会接管。
    const empty = buildPingOverviewItem("node-a", 1, []);
    expect(empty.isAssigned).toBe(false);
    expect(empty.samples).toEqual([]);
    expect(empty.lastValue).toBeNull();

    const unconfigured = buildPingOverviewItem("node-a", 4, [sample(1, { ct: 30 })]);
    expect(unconfigured.isAssigned).toBe(false);
  });

  it("infers the sample interval from the data instead of assuming one", () => {
    // 后端窗口是 2 分钟一个点，本地累积约 50 秒一个；柱子落位要跟着实际间隔走。
    const backend = buildPingOverviewItem("node-a", 1, [
      sample(6, { ct: 30 }),
      sample(4, { ct: 31 }),
      sample(2, { ct: 32 }),
    ]);
    expect(backend.metricIntervalMs).toBe(120_000);

    const local = buildPingOverviewItem("node-a", 1, [
      { time: NOW - 100_000, ping: { ...EMPTY_CARRIER_PING, ct: 30 } },
      { time: NOW - 50_000, ping: { ...EMPTY_CARRIER_PING, ct: 31 } },
      { time: NOW, ping: { ...EMPTY_CARRIER_PING, ct: 32 } },
    ]);
    expect(local.metricIntervalMs).toBe(50_000);
  });

  it("is not assigned for an unknown task id", () => {
    expect(buildPingOverviewItem("node-a", 99, [sample(1, { ct: 30 })]).isAssigned).toBe(
      false,
    );
  });
});

describe("buildPingBuckets", () => {
  it("spreads one-minute samples across the hour window", () => {
    const samples = Array.from({ length: 60 }, (_, index) =>
      sample(index, { ct: 40 + index, lossCt: 0 }),
    );
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, samples),
      24,
      NOW,
    );

    expect(buckets).toHaveLength(24);
    expect(buckets.every((bucket) => bucket.total > 0)).toBe(true);
    expect(buckets[0]?.startAt).toBe(NOW - 60 * MINUTE_MS);
    expect(buckets[23]?.endAt).toBe(NOW);
  });

  it("leaves buckets empty where no sample exists yet", () => {
    // 只有最近 5 分钟有数据：靠前的 bucket 应为空，而不是被填充。
    const samples = Array.from({ length: 5 }, (_, index) =>
      sample(index, { ct: 30, lossCt: 0 }),
    );
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, samples),
      24,
      NOW,
    );

    expect(buckets[0]?.value).toBeNull();
    expect(buckets[0]?.total).toBe(0);
    expect(buckets[23]?.value).toBe(30);
  });

  it("aggregates loss per bucket", () => {
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, [sample(1, { ct: 50, lossCt: 100 })]),
      24,
      NOW,
    );
    const last = buckets[23];

    expect(last?.loss).toBe(100);
    expect(last?.lost).toBe(1);
  });

  it("drops samples older than the window", () => {
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, [sample(180, { ct: 30 })]),
      24,
      NOW,
    );

    expect(buckets.every((bucket) => bucket.total === 0)).toBe(true);
  });
});

describe("resolveHomepagePingRequestMode", () => {
  it("keeps large and compact cards in multi mode when three lines are chosen", () => {
    expect(resolveHomepagePingRequestMode("large", true, [1, 2, 3])).toBe("multi");
    expect(resolveHomepagePingRequestMode("compact", true, [1, 2, 3])).toBe("multi");
  });

  it("falls back to a single line for mini and list cards", () => {
    expect(resolveHomepagePingRequestMode("mini", true, [1, 2, 3])).toBe("single");
    expect(resolveHomepagePingRequestMode("list", true, [1, 2, 3])).toBe("single");
  });

  it("stays single when multi ping is off or incomplete", () => {
    expect(resolveHomepagePingRequestMode("large", false, [1, 2, 3])).toBe("single");
    expect(resolveHomepagePingRequestMode("large", true, [1, 2])).toBe("single");
  });
});
