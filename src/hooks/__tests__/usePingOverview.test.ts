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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
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
  it("matches the 20 slots the backend returns for the window", () => {
    // 后端返回 20 条（2026-08-24 起窗口跨度从 1 小时拉到 2 小时，格数没变）。格数必须一一对应，
    // 否则一格里会混进相邻槽位、或者反过来空出格子。
    expect(HOMEPAGE_PING_BUCKET_COUNT).toBe(20);
  });

  it("默认按后端 2 小时窗口画 20 格：跨度自动跟着数据走，一格约 6 分钟", () => {
    // 后端 20 个点、每 ~6 分钟一个，整段约跨 2 小时。跨度不写死，由数据自己的时间范围决定 ——
    // 不传 windowMs 就自动取「最老一个点到 now」。
    const STEP_MS = 6 * MINUTE_MS;
    const samples = Array.from({ length: 20 }, (_, index) =>
      sample((19 - index) * 6, { ct: 40 + index, lossCt: 0 }),
    );
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, samples),
      undefined,
      NOW,
    );

    expect(buckets).toHaveLength(20);
    expect(buckets.every((bucket) => bucket.total > 0)).toBe(true);
    // 最老的点在 (19*6)=114 分钟前，跨度就画 114 分钟：右缘贴着 now，一格 ~5.7 分钟。
    expect(buckets[0]?.startAt).toBe(NOW - 19 * STEP_MS);
    expect(buckets[19]?.endAt).toBe(NOW);
  });
});

describe("buildPingBuckets 最左边那一格", () => {
  /**
   * 复刻线上的真实形状：后端窗口返回 20 行、步长 180 秒，末尾还混着本地实测（约 60 秒一个）
   * 把采样间隔的中位数拉低。跨度改成跟着数据走之后，最老的点正好落在 windowStart，第一格
   * 天然被盖住 —— 这组用例守的就是「无论最新一行多新，第一格都不空」。
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
    // age 在 0~180 秒之间循环（后端每几分钟出一行）。跨度跟着数据走后，最老的点就是 windowStart，
    // 第一格必被盖住 —— 从前固定 60 分钟窗口时 age < 44 秒第一格会空（站长说的「有时候」），现在不会。
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
    // 数据只跨 9 分钟、不足跨度下限（30 分钟），按下限撑开，左侧照旧留空 ——
    // 不能把「这台节点只有最近十分钟的数据」也涂满。
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
  it("spreads one-minute samples across a pinned hour window", () => {
    // 显式钉住 60 分钟跨度（windowMs），验证格子的落位与边界；生产里跨度是自动取的。
    const samples = Array.from({ length: 60 }, (_, index) =>
      sample(index, { ct: 40 + index, lossCt: 0 }),
    );
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, samples),
      24,
      NOW,
      undefined,
      HOUR_MS,
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
      undefined,
      HOUR_MS,
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
      undefined,
      HOUR_MS,
    );
    expect(partial[23]?.loss).toBeCloseTo(33, 5);

    const half = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, [sample(1, { ct: 50, lossCt: 50 })]),
      24,
      NOW,
      undefined,
      HOUR_MS,
    );
    expect(half[23]?.loss).toBeCloseTo(50, 5);
  });

  it("aggregates loss per bucket", () => {
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, [sample(1, { ct: 50, lossCt: 100 })]),
      24,
      NOW,
      undefined,
      HOUR_MS,
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
    const filled = buildPingBuckets(item, 24, NOW, undefined, HOUR_MS)
      .map((bucket) => (bucket.total > 0 ? "#" : "."))
      .join("");

    expect(filled.slice(filled.indexOf("#"))).not.toContain(".");
  });

  it("fills the leftmost bucket when the pinned window is slightly longer than the data", () => {
    // 显式钉住 60 分钟，但数据只跨 58 分钟（30 个点 × 2 分钟）：最老的点比第一格的中点还新，
    // 靠 leadingHold 向前补一段才不会空第一格。（生产里跨度自动跟着数据走，这种情形只在
    // 跨度撑到下限、或最老事件是空槽时出现。）
    const samples = Array.from({ length: 30 }, (_, index) =>
      sample(0.5 + (29 - index) * 2, { ct: 40 }),
    );
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, samples),
      24,
      NOW,
      undefined,
      HOUR_MS,
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
    const buckets = buildPingBuckets(item, 24, NOW, undefined, HOUR_MS);
    expect(buckets.some((bucket) => bucket.total === 0)).toBe(true);
  });

  it("stops holding a sample after five minutes", () => {
    // 数据真的断了就该留空，而不是让最后一格一路铺到现在。
    const item = buildPingOverviewItem("node-a", 1, [
      sample(40, { ct: 40 }),
      sample(38, { ct: 40 }),
    ]);
    const buckets = buildPingBuckets(item, 24, NOW, undefined, HOUR_MS);
    const last = buckets[buckets.length - 1];

    expect(last?.total).toBe(0);
  });

  it("drops samples older than the window", () => {
    const buckets = buildPingBuckets(
      buildPingOverviewItem("node-a", 1, [sample(180, { ct: 30 })]),
      24,
      NOW,
      undefined,
      HOUR_MS,
    );

    expect(buckets.every((bucket) => bucket.total === 0)).toBe(true);
  });

  describe("掉线", () => {
    // 钉住 60 分钟跨度、24 格 = 每格 2.5 分钟，红格进度才好逐格核对。
    const hourly = Array.from({ length: 60 }, (_, index) =>
      sample(index, { ct: 40, lossCt: 0 }),
    );
    const offlineBuckets = (offlineMinutesAgo: number) =>
      buildPingBuckets(
        buildPingOverviewItem("node-a", 1, hourly),
        24,
        NOW,
        NOW - offlineMinutesAgo * MINUTE_MS,
        HOUR_MS,
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
        HOUR_MS,
      );

      expect(buckets.filter((bucket) => bucket.offline).length).toBe(4);
      expect(buckets.every((bucket) => !bucket.offline || bucket.total === 0)).toBe(true);
    });

    it("在线时不标离线格", () => {
      const buckets = buildPingBuckets(
        buildPingOverviewItem("node-a", 1, hourly),
        24,
        NOW,
        undefined,
        HOUR_MS,
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
