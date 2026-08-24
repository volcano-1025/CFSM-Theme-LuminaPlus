import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_SETTINGS, normalizeThemeSettings } from "@/utils/themeSettings";

describe("normalizeThemeSettings", () => {
  it("keeps mini and falls unknown saved view modes back to compact", () => {
    const settings = normalizeThemeSettings({
      desktopNodeViewMode: "retired-view",
      mobileNodeViewMode: "retired-view",
    } as never);

    expect(settings.desktopNodeViewMode).toBe("compact");
    expect(settings.mobileNodeViewMode).toBe("compact");
    expect(normalizeThemeSettings({ desktopNodeViewMode: "mini" }).desktopNodeViewMode).toBe(
      "mini",
    );
    expect(normalizeThemeSettings({ mobileNodeViewMode: "mini" }).mobileNodeViewMode).toBe("mini");
    expect(normalizeThemeSettings({ mobileNodeViewMode: "list" }).mobileNodeViewMode).toBe(
      "compact",
    );
  });

  it("defaults overview ratings on unless explicitly disabled", () => {
    expect(normalizeThemeSettings({}).showOverviewRatings).toBe(true);
    expect(normalizeThemeSettings({ showOverviewRatings: false }).showOverviewRatings).toBe(false);
  });

  it("normalizes homepage multi-ping tasks while preserving an enabled draft for repair", () => {
    // 默认开三网，并补上电信/联通/移动 —— 少了任务 id 会静默退回单线路。
    const untouched = normalizeThemeSettings({});
    expect(untouched.enableHomepageMultiPing).toBe(true);
    expect(untouched.homepageMultiPingTaskIds).toEqual([1, 2, 3]);
    expect(normalizeThemeSettings({ enableHomepageMultiPing: false }).enableHomepageMultiPing).toBe(
      false,
    );
    // 显式配过就尊重原值（哪怕不足三条），让设置页提示补齐而不是被默认值盖掉。
    expect(
      normalizeThemeSettings({ homepageMultiPingTaskIds: [] }).homepageMultiPingTaskIds,
    ).toEqual([]);
    expect(
      normalizeThemeSettings({
        enableHomepageMultiPing: true,
        homepageMultiPingTaskIds: [3, 1],
      }).enableHomepageMultiPing,
    ).toBe(true);

    const resolved = normalizeThemeSettings({
      enableHomepageMultiPing: true,
      homepageMultiPingTaskIds: [3, 1, 3, 2, 4],
    });
    expect(resolved.enableHomepageMultiPing).toBe(true);
    expect(resolved.homepageMultiPingTaskIds).toEqual([3, 1, 2]);
  });

  it("defaults home sort to weight ascending and falls back to a field's natural direction", () => {
    const base = normalizeThemeSettings({});
    expect(base.enableHomeSort).toBe(true);
    expect(base.homeSortField).toBe("default");
    expect(base.homeSortDirection).toBe("asc");

    // 指定字段但缺省方向 → 回落该字段自然方向(网速为降序)。
    expect(normalizeThemeSettings({ homeSortField: "speed" } as never).homeSortDirection).toBe("desc");
    // 非法字段回落 default。
    expect(normalizeThemeSettings({ homeSortField: "nope" } as never).homeSortField).toBe("default");
  });

  it("keeps fake ping off unless explicitly enabled", () => {
    expect(normalizeThemeSettings({}).fakePingForUnbound).toBe(false);
    expect(normalizeThemeSettings({ fakePingForUnbound: true }).fakePingForUnbound).toBe(true);
    // 非布尔真值不算显式开启。
    expect(
      normalizeThemeSettings({ fakePingForUnbound: "yes" } as never).fakePingForUnbound,
    ).toBe(false);
  });

  it("parses hiddenNodes from a delimited string and dedupes", () => {
    expect(normalizeThemeSettings({}).hiddenNodes).toEqual([]);
    expect(
      normalizeThemeSettings({ hiddenNodes: "节点A, 节点A\nuuid-1；节点B" } as never).hiddenNodes,
    ).toEqual(["节点A", "uuid-1", "节点B"]);
  });

  it("round-trips its own output, so the copied JSON can be pasted into theme_options", () => {
    // 设置页的「复制配置 JSON」导出的就是这份快照，站长粘进后台后主题会再归一化一次读回来；
    // 不幂等的话，同步一次配置就会悄悄漂移。
    const snapshot = normalizeThemeSettings({
      defaultAppearance: "dark",
      desktopNodeViewMode: "compact",
      enableHomepageMultiPing: true,
      homepageMultiPingTaskIds: [1, 2, 3],
      hiddenNodes: "节点A, 节点B",
      surfaceOpacity: 0.72,
    } as never);
    const pasted = normalizeThemeSettings(JSON.parse(JSON.stringify(snapshot)) as never);

    expect(pasted).toEqual(snapshot);
  });

  it("每一个布尔设置都要能被 JSON 覆盖：漏接一个，「复制配置 JSON」就同步不过去", () => {
    // 这条是结构性护栏，不是某个设置的用例。加新设置时容易只写了类型、默认值和设置页开关，
    // 忘了在 normalizeThemeSettings 里读它 —— TS 查不出来（默认值把字段填上了），
    // 表现是：本机点得动，导出的 JSON 里也有这个键，粘到后台却永远是默认值。
    const missed: string[] = [];
    for (const [key, value] of Object.entries(DEFAULT_THEME_SETTINGS)) {
      if (typeof value !== "boolean") continue;
      const flipped = normalizeThemeSettings({ [key]: !value } as never) as unknown as Record<
        string,
        unknown
      >;
      if (flipped[key] !== !value) missed.push(key);
    }

    expect(missed).toEqual([]);
  });

  it("defaults 卡片显示价格 to on and honours an explicit false", () => {
    expect(normalizeThemeSettings(null).showCardPrice).toBe(true);
    expect(normalizeThemeSettings({ showCardPrice: false } as never).showCardPrice).toBe(false);
  });
});
