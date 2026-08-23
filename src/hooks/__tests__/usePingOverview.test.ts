import { describe, expect, it } from "vitest";
import {
  buildPingBuckets,
  HOMEPAGE_PING_BUCKET_COUNT,
  buildPingOverviewItem,
  resolveHomepagePingRequestMode,
  withLiveLatency,
} from "@/hooks/usePingOverview";
import type { PingLiveSample } from "@/services/pingLiveStore";
import { EMPTY_CARRIER_PING } from "@/types/cfsm";
import { HEALTH_BUCKET_COUNT } from "@/utils/pingWindowHealth";

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

  it("carries the per-sample loss through and averages it over the window", () => {
    // 卡片上的丢包率跟原版一样是整段窗口的平均，不是最后一次采样 ——
    // 否则一次抖动就把数字顶上去，下面的柱子却还是全绿。
    const item = buildPingOverviewItem("node-a", 1, [
      sample(3, { ct: 30, lossCt: 0 }),
      sample(1, { ct: 40, lossCt: 25 }),
    ]);

    expect(item.samples.map((entry) => entry.loss)).toEqual([0, 25]);
    expect(item.loss).toBeCloseTo(12.5, 5);
    // 延迟数字仍然是最新值。
    expect(item.lastValue).toBe(40);
  });

  it("leaves the loss empty when the backend never reports it", () => {
    const item = buildPingOverviewItem("node-a", 1, [
      sample(3, { ct: 30 }),
      sample(1, { ct: 40 }),
    ]);

    expect(item.loss).toBeNull();
  });

  it("keeps one spike from dominating the hour", () => {
    // 一小时 30 个点里有一个 100%，卡片应显示约 3.3%，不是 100%。
    const samples = Array.from({ length: 30 }, (_, index) =>
      sample(59 - index * 2, { ct: 40, lossCt: index === 29 ? 100 : 0 }),
    );

    expect(buildPingOverviewItem("node-a", 1, samples).loss).toBeCloseTo(100 / 30, 5);
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
    // 后端窗口是 2 分钟一个点，本地实测跟着探测节奏走；柱子落位要跟着实际间隔走。
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

describe("HOMEPAGE_PING_BUCKET_COUNT", () => {
  it("matches the 20 slots the backend returns for the hour window", () => {
    // 后端 2026-08-23 起从 D1 取一小时，由 30 条改为 20 条。格数必须一一对应，
    // 否则一格里会混进相邻槽位、或者反过来空出格子。
    expect(HOMEPAGE_PING_BUCKET_COUNT).toBe(20);
  });

  it("keeps the health self-check on the same grid as the cards", () => {
    // 自检判「柱子空缺」用的格数要和卡片一致，否则空缺比例的阈值会跟着飘。
    expect(HEALTH_BUCKET_COUNT).toBe(HOMEPAGE_PING_BUCKET_COUNT);
  });

  it("is what every view gets by default, so all four card sizes line up", () => {
    const samples = Array.from({ length: 60 }, (_, index) =>
      sample(index, { ct: 40 + index, lossCt: 0 }),
    );
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, samples),
      undefined,
      NOW,
    );

    expect(buckets).toHaveLength(20);
    // 一小时 20 格 = 一格 3 分钟，正好一个后端采样点。
    expect(buckets[0]?.startAt).toBe(NOW - 60 * MINUTE_MS);
    expect(buckets[0]?.endAt).toBe(NOW - 57 * MINUTE_MS);
    expect(buckets[19]?.endAt).toBe(NOW);
  });
});

describe("buildPingBuckets 最左边那一格", () => {
  /**
   * 复刻 2026-08-23 线上的真实形状：后端一小时窗口返回 20 行、步长 180 秒，
   * 整段只跨 57 分钟（实测 8 台 56.7~56.9 分钟），而图表画的是 60 分钟。
   * 缓冲区末尾还混着本地实测（约 60 秒一个），把采样间隔的中位数拉低。
   */
  const BACKEND_STEP_MS = 180_000;
  const LOCAL_STEP_MS = 60_000;

  function windowPlusLocal(newestAgeMs: number): PingLiveSample[] {
    const newest = NOW - newestAgeMs;
    // 后端 20 行，最老的在 newest - 19*180s
    const backend = Array.from({ length: 20 }, (_, index) => ({
      time: newest - (19 - index) * BACKEND_STEP_MS,
      ping: { ...EMPTY_CARRIER_PING, ct: 150, lossCt: 0 },
    }));
    // 本地实测：最近十分钟每 60 秒一个，足够把 delta 的中位数压到 60 秒
    const local = Array.from({ length: 12 }, (_, index) => ({
      time: NOW - (11 - index) * LOCAL_STEP_MS,
      ping: { ...EMPTY_CARRIER_PING, ct: 152, lossCt: 0 },
    }));
    return [...backend, ...local].sort((left, right) => left.time - right.time);
  }

  it("fills the oldest cell no matter how fresh the newest backend row is", () => {
    // age 在 0~180 秒之间循环（后端 3 分钟出一行）。改之前 age < 44 秒时第一格是空的，
    // 约占周期的四分之一 —— 站长看到的「有时候第一格空」就是它。
    for (const ageSec of [0, 10, 20, 30, 44, 60, 90, 120, 179]) {
      const buckets = buildPingBuckets(
        buildPingOverviewItem("node-a", 1, windowPlusLocal(ageSec * 1000)),
        undefined,
        NOW,
      );
      expect(buckets).toHaveLength(20);
      expect(
        buckets[0]?.value,
        `最新一行 ${ageSec} 秒前时第一格不该是空的`,
      ).not.toBeNull();
    }
  });

  it("still leaves the left side empty when the data genuinely starts late", () => {
    // 回填是有上限的（同 holdMs），不能把「这台节点只有最近十分钟的数据」也涂满。
    const samples = Array.from({ length: 10 }, (_, index) => ({
      time: NOW - (9 - index) * LOCAL_STEP_MS,
      ping: { ...EMPTY_CARRIER_PING, ct: 30, lossCt: 0 },
    }));
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, samples),
      undefined,
      NOW,
    );

    expect(buckets[0]?.value).toBeNull();
    expect(buckets[19]?.value).not.toBeNull();
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

  it("keeps partial packet loss instead of rounding it to 0 or 100", () => {
    // 后端给的是百分比（6 个包丢 2 个 → 33），按"丢了几个包"四舍五入会把 33% 变成 0%、
    // 50% 变成 100%，图上就只剩全绿和全红两种颜色。
    const partial = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, [sample(1, { ct: 50, lossCt: 33 })]),
      24,
      NOW,
    );
    expect(partial[23]?.loss).toBeCloseTo(33, 5);

    const half = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, [sample(1, { ct: 50, lossCt: 50 })]),
      24,
      NOW,
    );
    expect(half[23]?.loss).toBeCloseTo(50, 5);
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

  it("bridges the gap before an off-grid newest point", () => {
    // 后端窗口的最新一格常常不落在 2 分钟网格上，与上一格能差 4~5 分钟。
    // 一格样本要延续到下一次采样为止，否则最右边会凭空空一格，而且随 now 推进时有时无。
    const samples = [
      ...Array.from({ length: 10 }, (_, index) => sample(24 - index * 2, { ct: 40 })),
      sample(0.5, { ct: 42 }),
    ];
    const item = buildPingOverviewItem("node-a", 1, samples);
    const filled = buildPingBuckets(item, 24, NOW)
      .map((bucket) => (bucket.total > 0 ? "#" : "."))
      .join("");

    expect(filled.slice(filled.indexOf("#"))).not.toContain(".");
  });

  it("fills the leftmost bucket when the window is slightly shorter than an hour", () => {
    // 后端窗口是 30 个点 × 2 分钟 = 58 分钟，图表画 60 分钟：
    // 最老的点大约在 59 分钟前，比第一格的中点还新，不补就永远空第一格。
    const samples = Array.from({ length: 30 }, (_, index) =>
      sample(0.5 + (29 - index) * 2, { ct: 40 }),
    );
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, samples),
      24,
      NOW,
    );

    expect(buckets[0]?.total).toBeGreaterThan(0);
    expect(buckets.every((bucket) => bucket.total > 0)).toBe(true);
  });

  it("keeps a real gap where the window reported no measurement", () => {
    // 槽位存在但该线路没值（节点掉线/探测失败）是真的空档，不能被相邻样本填平。
    const samples = [
      sample(10, { ct: 40 }),
      sample(8, {}),
      sample(6, {}),
      sample(4, { ct: 41 }),
      sample(0.5, { ct: 42 }),
    ];
    const item = buildPingOverviewItem("node-a", 1, samples);

    expect(item.emptyTimes).toHaveLength(2);
    const buckets = buildPingBuckets(item, 24, NOW);
    expect(buckets.some((bucket) => bucket.total === 0)).toBe(true);
  });

  it("stops holding a sample after five minutes", () => {
    // 数据真的断了就该留空，而不是让最后一格一路铺到现在。
    const item = buildPingOverviewItem("node-a", 1, [
      sample(40, { ct: 40 }),
      sample(38, { ct: 40 }),
    ]);
    const buckets = buildPingBuckets(item, 24, NOW);
    const last = buckets[buckets.length - 1];

    expect(last?.total).toBe(0);
  });

  it("drops samples older than the window", () => {
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, [sample(180, { ct: 30 })]),
      24,
      NOW,
    );

    expect(buckets.every((bucket) => bucket.total === 0)).toBe(true);
  });

  describe("掉线", () => {
    // 一小时 24 格 = 每格 2.5 分钟。
    const hourly = Array.from({ length: 60 }, (_, index) =>
      sample(index, { ct: 40, lossCt: 0 }),
    );
    const offlineBuckets = (offlineMinutesAgo: number) =>
      buildPingBuckets(
        buildPingOverviewItem("node-a", 1, hourly),
        24,
        NOW,
        NOW - offlineMinutesAgo * MINUTE_MS,
      );

    it("红格一格一格往左推，掉线不满一格时不涂红", () => {
      const redCount = (minutes: number) =>
        offlineBuckets(minutes).filter((bucket) => bucket.offline).length;

      expect(redCount(1)).toBe(0);
      expect(redCount(3)).toBe(1);
      expect(redCount(6)).toBe(2);
      expect(redCount(11)).toBe(4);
      expect(redCount(61)).toBe(24);
    });

    it("掉线之后的样本不参与聚合：后端窗口可能还在按墙钟续格子", () => {
      const stale = [
        sample(20, { ct: 40, lossCt: 0 }),
        // 掉线后后端沿用旧值继续铺的格子
        sample(4, { ct: 40, lossCt: 0 }),
        sample(1, { ct: 40, lossCt: 0 }),
      ];
      const buckets = buildPingBuckets(
        buildPingOverviewItem("node-a", 1, stale),
        24,
        NOW,
        NOW - 10 * MINUTE_MS,
      );

      expect(buckets.filter((bucket) => bucket.offline).length).toBe(4);
      expect(buckets.every((bucket) => !bucket.offline || bucket.total === 0)).toBe(true);
    });

    it("在线时不标离线格", () => {
      const buckets = buildPingBuckets(
        buildPingOverviewItem("node-a", 1, hourly),
        24,
        NOW,
      );

      expect(buckets.some((bucket) => bucket.offline)).toBe(false);
    });
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

describe("withLiveLatency", () => {
  const item = buildPingOverviewItem("node-a", 1, [sample(2, { ct: 30 })]);
  const live = (values: Partial<PingLiveSample["ping"]>) => ({
    ...EMPTY_CARRIER_PING,
    ...values,
  });

  it("数字用 WS 的实时值，窗口末点最多能滞后一格", () => {
    expect(withLiveLatency(item, live({ ct: 44 }), 1).lastValue).toBe(44);
  });

  it("只换数字，柱子和丢包率仍按窗口来", () => {
    const next = withLiveLatency(item, live({ ct: 44 }), 1);

    expect(next.samples).toBe(item.samples);
    expect(next.loss).toBe(item.loss);
  });

  it("探测失败（负值）或没有值时保持窗口给的数", () => {
    expect(withLiveLatency(item, live({ ct: -1 }), 1).lastValue).toBe(30);
    expect(withLiveLatency(item, live({ cu: 44 }), 1).lastValue).toBe(30);
  });

  it("值没变就返回原对象，不白白触发重渲染", () => {
    expect(withLiveLatency(item, live({ ct: 30 }), 1)).toBe(item);
    expect(withLiveLatency(item, null, 1)).toBe(item);
  });
});
