import { describe, expect, it } from "vitest";
import type uPlot from "uplot";
import {
  buildLoadTimeRangeOptions,
  buildPingTimeRangeOptions,
  SPARSE_SERIES_POINTS,
} from "@/components/instance/chartShared";

const ALL_STEPS = [
  { label: "1 小时", value: 1 },
  { label: "6 小时", value: 6 },
  { label: "12 小时", value: 12 },
  { label: "1 天", value: 24 },
  { label: "2 天", value: 48 },
  { label: "7 天", value: 168 },
];

describe("detail chart time ranges", () => {
  it("offers every backend-supported step to a logged-in admin", () => {
    // 后端 /api/history/all 最长支持 7 天，没有更长的档位可选。
    expect(buildPingTimeRangeOptions(168)).toEqual(ALL_STEPS);
    expect(buildLoadTimeRangeOptions(168)).toEqual([
      { label: "实时", value: 0 },
      ...ALL_STEPS,
    ]);
  });

  it("caps anonymous visitors at 24 hours", () => {
    // 未登录时 hours > 24 会被后端拒绝，因此更长的档位不显示。
    expect(buildPingTimeRangeOptions(24)).toEqual([
      { label: "1 小时", value: 1 },
      { label: "6 小时", value: 6 },
      { label: "12 小时", value: 12 },
      { label: "1 天", value: 24 },
    ]);
    expect(buildLoadTimeRangeOptions(24)).toEqual([
      { label: "实时", value: 0 },
      { label: "1 小时", value: 1 },
      { label: "6 小时", value: 6 },
      { label: "12 小时", value: 12 },
      { label: "1 天", value: 24 },
    ]);
  });
});

describe("sparse series points", () => {
  type PointsShow = (self: uPlot, seriesIdx: number, idx0: number, idx1: number) => boolean;
  type PointsFilter = (self: uPlot, seriesIdx: number, show: boolean) => number[] | null;
  const show = SPARSE_SERIES_POINTS.show as PointsShow;
  const filter = SPARSE_SERIES_POINTS.filter as PointsFilter;

  /** 横轴 600 像素宽，覆盖 [min, max] 秒。 */
  const fakePlot = (
    times: number[],
    values: (number | null)[],
    range: [number, number],
    spanGaps = false,
  ) =>
    ({
      data: [times, values],
      series: [{}, { spanGaps }],
      valToPos: (value: number) => ((value - range[0]) / (range[1] - range[0])) * 600,
    }) as unknown as uPlot;

  it("does not circle every point when the line spans the chart", () => {
    // 「实时」档刚进来：10 分钟、30 秒一行、正好 20 个点，线铺满整张图。
    const times = Array.from({ length: 20 }, (_, index) => index * 30);
    const plot = fakePlot(times, times.map(() => 1), [0, 600]);
    expect(show(plot, 1, 0, 19)).toBe(false);
    expect(filter(plot, 1, false)).toBeNull();
  });

  it("draws points when the data is squeezed into a sliver of a long axis", () => {
    // 新节点：「12 小时」档只有最后 1 分钟的数据，线不到 1 像素。
    const plot = fakePlot([43_140, 43_170, 43_200], [1, 2, 3], [0, 43_200]);
    expect(show(plot, 1, 0, 2)).toBe(true);
  });

  it("draws a lone point", () => {
    const plot = fakePlot([0, 300, 600], [null, 5, null], [0, 600]);
    expect(show(plot, 1, 0, 2)).toBe(true);
    expect(show(fakePlot([0, 300], [null, null], [0, 600]), 1, 0, 1)).toBe(false);
  });

  it("only marks isolated points inside a long line", () => {
    const times = [0, 100, 200, 300, 400, 500, 600];
    const values = [1, 2, null, 3, null, 4, 5];
    expect(show(fakePlot(times, values, [0, 600]), 1, 0, 6)).toBe(false);
    expect(filter(fakePlot(times, values, [0, 600]), 1, false)).toEqual([3]);
    // 「断点连线」开着时线会接上，不用补点。
    expect(filter(fakePlot(times, values, [0, 600], true), 1, false)).toBeNull();
  });
});
