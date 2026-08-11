// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLocalThemeSettings,
  resetLocalThemeSettings,
  saveLocalThemeSettings,
  subscribeLocalThemeSettings,
} from "@/services/themeSettingsStore";
import { normalizeThemeSettings } from "@/utils/themeSettings";

const STORAGE_KEY = "cfsm-luminaplus:theme-settings";

beforeEach(() => {
  window.localStorage.clear();
  resetLocalThemeSettings();
});

afterEach(() => {
  window.localStorage.clear();
  resetLocalThemeSettings();
});

describe("themeSettingsStore", () => {
  it("persists settings across a page reload", async () => {
    saveLocalThemeSettings({ defaultAppearance: "dark", desktopNodeViewMode: "compact" });
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain("dark");

    // 刷新 = 模块重新求值（内存缓存清空），只剩 localStorage 里的内容。
    vi.resetModules();
    const reloaded = await import("@/services/themeSettingsStore");

    expect(reloaded.getLocalThemeSettings()).toMatchObject({
      defaultAppearance: "dark",
      desktopNodeViewMode: "compact",
    });
  });

  it("ignores a corrupted storage payload instead of throwing", async () => {
    window.localStorage.setItem(STORAGE_KEY, "{ not json");
    vi.resetModules();
    const reloaded = await import("@/services/themeSettingsStore");

    expect(reloaded.getLocalThemeSettings()).toEqual({});
  });

  it("notifies subscribers on save and reset", () => {
    let calls = 0;
    const unsubscribe = subscribeLocalThemeSettings(() => {
      calls += 1;
    });

    saveLocalThemeSettings({ showConnections: true });
    resetLocalThemeSettings();
    unsubscribe();
    saveLocalThemeSettings({ showConnections: false });

    expect(calls).toBe(2);
  });

  it("returns a new object identity after each save, so hooks re-render", () => {
    const before = getLocalThemeSettings();
    saveLocalThemeSettings({ showConnections: true });
    expect(getLocalThemeSettings()).not.toBe(before);
  });
});

/**
 * 全站读取主题设置的口径：站点预设（后端 theme_options）打底，本机覆盖在上。
 * 曾经有几处只读了后端，导致本机保存的设置在刷新后被站点默认值冲掉。
 */
describe("站点预设与本机覆盖的合并口径", () => {
  const merge = (remote: Record<string, unknown>, local: Record<string, unknown>) =>
    normalizeThemeSettings({ ...remote, ...local });

  it("本机覆盖优先于站点预设", () => {
    const resolved = merge(
      { defaultAppearance: "light", desktopNodeViewMode: "large" },
      { defaultAppearance: "dark" },
    );

    expect(resolved.defaultAppearance).toBe("dark");
    // 本机没覆盖的键仍然沿用站点预设。
    expect(resolved.desktopNodeViewMode).toBe("large");
  });

  it("两边都没有的键落到主题默认值", () => {
    expect(merge({}, {}).defaultAppearance).toBe("system");
  });

  it("只读站点预设会丢掉本机设置（回归用例）", () => {
    const local = { defaultAppearance: "dark" as const };
    // 错误口径：忽略 local。
    expect(normalizeThemeSettings({}).defaultAppearance).toBe("system");
    // 正确口径。
    expect(merge({}, local).defaultAppearance).toBe("dark");
  });

  it("保存本页设置时合并已有本地键，不清掉配色选择器写的值", () => {
    saveLocalThemeSettings({ metricColors: { cpu: "#ff0000" }, darkDepth: 60 } as never);

    const pageDraft = { defaultAppearance: "dark" as const, showConnections: true };
    saveLocalThemeSettings({ ...getLocalThemeSettings(), ...pageDraft });

    expect(getLocalThemeSettings()).toMatchObject({
      metricColors: { cpu: "#ff0000" },
      darkDepth: 60,
      defaultAppearance: "dark",
      showConnections: true,
    });
  });
});
