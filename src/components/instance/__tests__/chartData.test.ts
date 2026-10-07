import { describe, expect, it } from "vitest";
import {
  appendLiveChartPoint,
  cutPeakValues,
  downsampleAligned,
  fillMissingMetricPoints,
  insertMetricGapSentinels,
  mergeHistoryWithLivePoints,
  type TimedMetricPoint,
  resampleLiveTail,
} from "@/components/instance/chartData";

describe("fillMissingMetricPoints", () => {
  it("keeps the newest sample's own timestamp instead of snapping it to the grid", () => {
    // 末点 (t=35) 不在 10ms 网格上；不能被拉回到 t=30。
    const points: TimedMetricPoint[] = [
      { time: 0, v: 1 },
      { time: 10, v: 2 },
      { time: 20, v: 3 },
      { time: 35, v: 9 },
    ];
    const filled = fillMissingMetricPoints(points, { intervalSeconds: 10, matchToleranceSeconds: 5 });
    const last = filled[filled.length - 1];
    expect(last.time).toBe(35);
    expect(last.v).toBe(9);
  });

  it("leaves on-grid series untouched at the trailing edge", () => {
    const points: TimedMetricPoint[] = [
      { time: 0, v: 1 },
      { time: 10, v: 2 },
      { time: 20, v: 3 },
    ];
    const filled = fillMissingMetricPoints(points, { intervalSeconds: 10, matchToleranceSeconds: 5 });
    expect(filled.map((p) => p.time)).toEqual([0, 10, 20]);
    expect(filled[filled.length - 1].v).toBe(3);
  });

  it("keeps a trailing sample outside the final grid tolerance", () => {
    const points: TimedMetricPoint[] = [
      { time: 0, v: 1 },
      { time: 10, v: 2 },
      { time: 20, v: 3 },
      { time: 36, v: 4 },
    ];

    const filled = fillMissingMetricPoints(points, {
      intervalSeconds: 10,
      matchToleranceSeconds: 5,
    });

    expect(filled.map((point) => point.time)).toEqual([0, 10, 20, 30, 36]);
    expect(filled[filled.length - 1].v).toBe(4);
  });

  it("prefers an exact trailing sample over an earlier point snapped to the same grid time", () => {
    const filled = fillMissingMetricPoints(
      [
        { time: 0, v: 1 },
        { time: 10, v: 2 },
        { time: 16, v: 3 },
        { time: 20, v: 4 },
      ],
      { intervalSeconds: 10, matchToleranceSeconds: 5 },
    );

    expect(filled[filled.length - 1]).toMatchObject({ time: 20, v: 4 });
  });
});

describe("cutPeakValues", () => {
  it("preserves genuine loss gaps instead of backfilling them (regression)", () => {
    const points = [
      { time: 1, t1: 50 },
      { time: 2, t1: 52 },
      { time: 3, t1: null }, // 丢包——必须保持为空缺
      { time: 4, t1: 51 },
      { time: 5, t1: 50 },
    ];

    const out = cutPeakValues(points, ["t1"]);

    expect(out[2].t1).toBeNull();
    // 周围的采样仍是真实数字 (EWMA 平滑后)，没有被置空。
    expect(typeof out[0].t1).toBe("number");
    expect(typeof out[4].t1).toBe("number");
  });

  it("does not invent values across a multi-point outage", () => {
    const points = [
      { time: 1, t1: 40 },
      { time: 2, t1: null },
      { time: 3, t1: null },
      { time: 4, t1: null },
      { time: 5, t1: 42 },
    ];

    const out = cutPeakValues(points, ["t1"]);

    expect(out[1].t1).toBeNull();
    expect(out[2].t1).toBeNull();
    expect(out[3].t1).toBeNull();
  });
});

describe("insertMetricGapSentinels — three-state ping semantics", () => {
  const opts = (intervals: Record<string, number>) => ({
    intervals: new Map(Object.entries(intervals)),
    matchToleranceRatio: 0.25,
  });
  const at = (points: TimedMetricPoint[], time: number) =>
    points.find((point) => point.time === time);

  it("keeps an off-phase anchor as undefined (spannable), not null", () => {
    // A 和 B 都每 60s 采样但错开 30s，所以各自建的 anchor 对方都没采过。这些 off-phase 格子
    // 必须保持 undefined，uPlot 才会跨过而非切断每条线——正是当初的空白图表 bug。
    const points: TimedMetricPoint[] = [
      { time: 0, A: 10 },
      { time: 30, B: 20 },
      { time: 60, A: 11 },
      { time: 90, B: 21 },
      { time: 120, A: 12 },
      { time: 150, B: 22 },
    ];

    const out = insertMetricGapSentinels(points, opts({ A: 60, B: 60 }));

    const p0 = at(out, 0)!;
    expect(p0.A).toBe(10);
    expect(p0.B).toBeUndefined();
    const p30 = at(out, 30)!;
    expect(p30.B).toBe(20);
    expect(p30.A).toBeUndefined();
  });

  it("preserves real loss (null) as a break", () => {
    const points: TimedMetricPoint[] = [
      { time: 0, A: 10 },
      { time: 60, A: null }, // value < 0（丢包）已被分桶器编码成 null；0 是亚毫秒成功，不入此列
      { time: 120, A: 12 },
    ];

    const out = insertMetricGapSentinels(points, opts({ A: 60 }));

    expect(at(out, 60)!.A).toBeNull();
  });

  it("tolerates a single missed sample (gap <= 2x interval)", () => {
    const points: TimedMetricPoint[] = [
      { time: 0, A: 10 },
      { time: 120, A: 12 }, // 60 处漏了一个采样 → 空缺正好是 2 倍 interval
      { time: 180, A: 13 },
    ];

    const out = insertMetricGapSentinels(points, opts({ A: 60 }));

    expect(out.every((point) => point.A !== null)).toBe(true);
  });

  it("bridges up to two consecutive missed samples (gap <= 3x interval)", () => {
    // 连续漏两次采样 → 空缺正好 3 倍 interval，仍视为抖动/漏采而非中断，保持可跨过(不插 null)。
    const points: TimedMetricPoint[] = [
      { time: 0, A: 10 },
      { time: 180, A: 13 }, // 60、120 两处漏采 → 空缺 = 3 倍 interval
      { time: 240, A: 14 },
    ];

    const out = insertMetricGapSentinels(points, opts({ A: 60 }));

    expect(out.every((point) => point.A !== null)).toBe(true);
  });

  it("breaks once the gap exceeds 6x interval", () => {
    // 空缺 = 7 倍 interval（> 桥接阈值 6×=360s）→ 真实较长中断，必须插 null 断点。
    const points: TimedMetricPoint[] = [
      { time: 0, A: 10 },
      { time: 420, A: 14 }, // 中间漏采 6 次 → 空缺 = 7 倍 interval
      { time: 480, A: 15 },
    ];

    const out = insertMetricGapSentinels(points, opts({ A: 60 }));

    expect(out.some((point) => point.A === null)).toBe(true);
  });

  it("breaks only the gapped task on a long outage, sparing co-located anchors", () => {
    // A 在 60..480 间中断（空缺 7×interval > 阈值），而 B 持续采样。A 的断点必须落到 B 的
    // anchor 上 (合并而非跳过)，且不能破坏 B 的真实值。
    const points: TimedMetricPoint[] = [
      { time: 0, A: 10, B: 100 },
      { time: 60, A: 11, B: 101 },
      { time: 120, B: 102 },
      { time: 180, B: 103 },
      { time: 240, B: 104 },
      { time: 300, B: 105 },
      { time: 360, B: 106 },
      { time: 420, B: 107 },
      { time: 480, A: 15, B: 108 },
    ];

    const out = insertMetricGapSentinels(points, opts({ A: 60, B: 60 }));

    const p120 = at(out, 120)!;
    expect(p120.A).toBeNull(); // A 断开，合并到 B 已有的 anchor 上
    expect(p120.B).toBe(102); // B 不受影响
  });

  it("merges sentinels when multiple tasks gap at the same time", () => {
    // A 和 B 都在 60..480 间中断（空缺 7×interval）且其间没有 anchor，所以各自在相同的期望
    // 时间播下哨兵——第二个必须合并而非覆盖。
    const points: TimedMetricPoint[] = [
      { time: 0, A: 10, B: 100 },
      { time: 60, A: 11, B: 101 },
      { time: 480, A: 15, B: 105 },
    ];

    const out = insertMetricGapSentinels(points, opts({ A: 60, B: 60 }));

    const p120 = at(out, 120)!;
    expect(p120).toBeDefined();
    expect(p120!.A).toBeNull();
    expect(p120!.B).toBeNull();
  });
});

describe("downsampleAligned", () => {
  it("keeps a real null break even when the same bucket also contains numeric samples", () => {
    const out = downsampleAligned(
      [0, 10, 20, 30],
      [[10, null, 14, 16]],
      2,
    );

    expect(out.times).toHaveLength(2);
    expect(out.perTask[0][0]).toBeNull();
    expect(out.perTask[0][1]).toBe(15);
  });

  it("keeps off-phase-only buckets undefined", () => {
    const out = downsampleAligned(
      [0, 10, 20, 30],
      [[undefined, undefined, 14, 16]],
      2,
    );

    expect(out.perTask[0][0]).toBeUndefined();
    expect(out.perTask[0][1]).toBe(15);
  });

  it("averages by default but pushes through a real spike when preservePeaks=true", () => {
    // 桶0 = {50, 500} 含尖峰；桶1 = {50, 52} 平坦。
    const mean = downsampleAligned([0, 10, 20, 30], [[50, 500, 50, 52]], 2);
    expect(mean.perTask[0][0]).toBe(275); // 默认均值把尖峰摊平

    const peak = downsampleAligned([0, 10, 20, 30], [[50, 500, 50, 52]], 2, true);
    expect(peak.perTask[0][0]).toBe(500); // 保峰：尖峰穿透
    expect(peak.perTask[0][1]).toBe(51); // 平坦桶仍取均值，基线干净
  });

  it("still prioritizes null breaks over peaks in preservePeaks mode", () => {
    const out = downsampleAligned([0, 10, 20, 30], [[50, null, 14, 16]], 2, true);
    expect(out.perTask[0][0]).toBeNull(); // 桶内有丢包 → 断点优先，不被尖峰逻辑覆盖
    expect(out.perTask[0][1]).toBe(15);
  });
});

describe("历史图接实时样本", () => {
  const point = (time: number, v: number): TimedMetricPoint => ({ time, v });

  it("同一秒的重复样本不重复记", () => {
    const first = appendLiveChartPoint([point(100, 1)], point(100.4, 2));
    expect(first).toHaveLength(1);
    expect(first[0]!.v).toBe(1);
  });

  it("实时档超上限砍最老的", () => {
    let points: TimedMetricPoint[] = [];
    for (let i = 0; i < 12; i += 1) {
      points = appendLiveChartPoint(points, point(i * 2, i), { dense: true, limit: 5 });
    }
    expect(points).toHaveLength(5);
    expect(points[0]!.time).toBe(14);
  });

  it("历史档超上限时抽稀老的那截，不在历史末尾留缝", () => {
    // 2 秒一帧连看两小时（3600 条，远超上限）：抽稀之后最老的一条还在原地，
    // 历史末尾和实时段之间不会被砍出一道缝。
    let points: TimedMetricPoint[] = [];
    for (let i = 0; i < 3600; i += 1) {
      points = appendLiveChartPoint(points, point(i * 2, i));
    }
    expect(points.length).toBeLessThanOrEqual(900);
    expect(points[0]!.time).toBe(0);
    expect(points[points.length - 1]!.time).toBe(7198);
    // 最近 5 分钟保持原密度，更早的按 30 秒一条。
    const newest = points[points.length - 1]!.time;
    const recent = points.filter((item) => item.time >= newest - 300);
    expect(recent.length).toBeGreaterThan(140);
  });

  it("只接历史末尾之后的实时样本", () => {
    const history = [point(0, 1), point(30, 2), point(60, 3)];
    const live = [point(40, 9), point(60, 9), point(62, 4), point(64, 5)];
    const merged = mergeHistoryWithLivePoints(history, live);
    expect(merged.map((item) => item.time)).toEqual([0, 30, 60, 62, 64]);
    // 历史覆盖到的时刻仍用历史的值。
    expect(merged[2]!.v).toBe(3);
  });

  it("没有实时样本时原样返回历史", () => {
    const history = [point(0, 1)];
    expect(mergeHistoryWithLivePoints(history, [])).toBe(history);
  });
});

describe("resampleLiveTail（历史档接实时样本按历史点距并格）", () => {
  // 历史 60 秒一行（站长站点 1 小时档实测），实时样本 2 秒一个。
  const history = Array.from({ length: 10 }, (_, index) => ({ time: 1_000 + index * 60, cpu: 1 }));
  const lastHistory = history[history.length - 1]!.time;
  const liveEvery2s = (seconds: number, cpu: (index: number) => number) =>
    Array.from({ length: seconds / 2 }, (_, index) => ({ time: lastHistory + 2 + index * 2, cpu: cpu(index) }));

  it("5 分钟的实时样本并成约 5 个点，最后一个落在最新样本的时刻", () => {
    const live = liveEvery2s(300, () => 2);
    const tail = resampleLiveTail(history, live, ["cpu"]);

    expect(tail.length).toBeGreaterThanOrEqual(5);
    expect(tail.length).toBeLessThanOrEqual(6);
    expect(tail[tail.length - 1]!.time).toBe(live[live.length - 1]!.time);
    for (let index = 1; index < tail.length; index += 1) {
      expect(tail[index]!.time).toBeGreaterThan(tail[index - 1]!.time);
    }
    expect(tail.every((point) => point.cpu === 2)).toBe(true);
  });

  it("格子里有尖峰就留峰值，平稳就取均值", () => {
    const live = liveEvery2s(120, (index) => (index === 5 ? 90 : index < 29 ? 1 : 3));
    const [first, second] = resampleLiveTail(history, live, ["cpu"]);

    expect(first!.cpu).toBe(90);
    expect(second!.cpu).toBeCloseTo(3);
  });

  it("历史末尾之前的实时样本丢掉，只剩一个就原样返回", () => {
    const live = [
      { time: lastHistory - 10, cpu: 50 },
      { time: lastHistory + 2, cpu: 4 },
    ];
    expect(resampleLiveTail(history, live, ["cpu"])).toEqual([{ time: lastHistory + 2, cpu: 4 }]);
  });

  it("全是 null 的指标（比如没有 Swap）并完还是 null", () => {
    const live = liveEvery2s(60, () => 1).map((point) => ({ ...point, swap: null as number | null }));
    const tail = resampleLiveTail<{ time: number; cpu: number; swap?: number | null }>(history, live, [
      "cpu",
      "swap",
    ]);
    expect(tail.every((point) => point.swap === null)).toBe(true);
  });

  it("指定格宽时按指定的并（「实时」档 10 秒一格）", () => {
    const live = liveEvery2s(60, () => 2);
    const tail = resampleLiveTail(history, live, ["cpu"], 10);
    expect(tail.length).toBeGreaterThanOrEqual(6);
    expect(tail.length).toBeLessThanOrEqual(7);
  });
});
