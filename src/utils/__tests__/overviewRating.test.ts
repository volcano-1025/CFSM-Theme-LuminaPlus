import { describe, expect, it } from "vitest";
import {
  getOverviewRating,
  normalizeOverviewRatingLabels,
} from "@/utils/overviewRating";

const GB = 1024 ** 3;

describe("overview ratings", () => {
  it("rates assets by the configured CNY ranges", () => {
    expect(getOverviewRating({ kind: "asset", value: 500 })).toEqual({
      level: 0,
      label: "入门",
    });
    expect(getOverviewRating({ kind: "asset", value: 1500 })).toEqual({
      level: 1,
      label: "标准",
    });
    expect(getOverviewRating({ kind: "asset", value: 3000 })).toEqual({
      level: 2,
      label: "顶级",
    });
    expect(getOverviewRating({ kind: "asset", value: 3000.01 })).toEqual({
      level: 3,
      label: "富佬",
    });
  });

  it("rates traffic and bandwidth on their native byte inputs", () => {
    expect(getOverviewRating({ kind: "traffic", value: 740 * GB })).toEqual({
      level: 1,
      label: "常规",
    });
    expect(getOverviewRating({ kind: "bandwidth", value: 672 * 1024 / 8 })).toEqual({
      level: 0,
      label: "闲置",
    });
  });

  it("accepts custom comma-separated labels and only takes the first four", () => {
    expect(normalizeOverviewRatingLabels("asset", "一,二,三,四,五")).toEqual([
      "一",
      "二",
      "三",
      "四",
    ]);
  });

  it("applies custom labels to the resolved rating", () => {
    expect(
      getOverviewRating({ kind: "asset", value: 1063.83, customLabels: "练气,筑基,结丹,元婴" }),
    ).toEqual({
      level: 1,
      label: "筑基",
    });
  });

  it("falls back by position when custom labels are incomplete", () => {
    expect(normalizeOverviewRatingLabels("asset", "萌新,进阶")).toEqual([
      "萌新",
      "进阶",
      "顶级",
      "富佬",
    ]);
  });
});
