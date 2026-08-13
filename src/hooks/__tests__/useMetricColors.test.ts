import { describe, expect, it } from "vitest";
import {
  DEFAULT_DARK_DEPTH,
  normalizeDarkDepth,
  pickPaletteSettings,
  readDarkDepthFromSettings,
} from "@/hooks/useMetricColors";

describe("dark depth settings", () => {
  it("keeps the existing gray-black palette as the default", () => {
    expect(readDarkDepthFromSettings(undefined)).toBe(DEFAULT_DARK_DEPTH);
    expect(readDarkDepthFromSettings({})).toBe(0);
  });

  it("rounds and clamps the persisted depth to the safe 0-100 range", () => {
    expect(normalizeDarkDepth(42.6)).toBe(43);
    expect(normalizeDarkDepth(-20)).toBe(0);
    expect(normalizeDarkDepth(180)).toBe(100);
  });

  it("falls back for invalid values and accepts a numeric stored string", () => {
    expect(readDarkDepthFromSettings({ darkDepth: "75" })).toBe(75);
    expect(readDarkDepthFromSettings({ darkDepth: "black" })).toBe(0);
  });
});

describe("pickPaletteSettings", () => {
  // 设置页「复制配置 JSON」靠它把取色器调的配色带进快照，漏了站长同步过去就是默认色。
  it("exports the picked colors and a non-default dark depth", () => {
    expect(
      pickPaletteSettings({
        defaultAppearance: "dark",
        metricColors: { cpu: "#3B82F6", disk: "#EF7C22" },
        darkDepth: 60,
      }),
    ).toEqual({ metricColors: { cpu: "#3b82f6", disk: "#ef7c22" }, darkDepth: 60 });
  });

  it("omits both keys when nothing was customised", () => {
    expect(pickPaletteSettings(undefined)).toEqual({});
    expect(pickPaletteSettings({ metricColors: {}, darkDepth: DEFAULT_DARK_DEPTH })).toEqual({});
    // 非法 hex 和未知指标都不进快照，避免把脏值同步成站点预设。
    expect(pickPaletteSettings({ metricColors: { cpu: "red", bogus: "#ffffff" } })).toEqual({});
  });
});
