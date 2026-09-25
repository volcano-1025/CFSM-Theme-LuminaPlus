// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { changedManagedSettings, draftFromSettings, rebaseDraft } from "@/pages/ThemeManage";
import type { ThemeSettings } from "@/types/cfsm";
import { normalizeThemeSettings } from "@/utils/themeSettings";

function resolved(settings: Record<string, unknown>) {
  return normalizeThemeSettings(settings as ThemeSettings & Record<string, unknown>);
}

describe("设置页自动保存只存改过的项", () => {
  it("没改的项不进本机，站长同步时才不会把别的设备改过的写回旧值", () => {
    const source = resolved({ surfaceOpacity: 100, desktopNodeViewMode: "card" });
    const draft = { ...source, desktopNodeViewMode: "list" } as ThemeSettings;

    expect(changedManagedSettings(draft, source)).toEqual({ desktopNodeViewMode: "list" });
  });

  it("什么都没改就是空的", () => {
    const source = resolved({ surfaceOpacity: 80 });
    expect(changedManagedSettings({ ...source } as ThemeSettings, source)).toEqual({});
  });
});

describe("设置变了时草稿按项合并（rebaseDraft）", () => {
  it("用户改过的留着，没改的跟上新设置", () => {
    const base = draftFromSettings(resolved({ surfaceOpacity: 100, enableHomepageMultiPing: true }));
    const current = { ...base, desktopNodeViewMode: "list" as const };
    // 别的设备把透明度改成 50、关掉多线路。
    const next = draftFromSettings(resolved({ surfaceOpacity: 50, enableHomepageMultiPing: false }));

    const rebased = rebaseDraft(current, base, next);

    expect(rebased.surfaceOpacity).toBe(50);
    expect(rebased.enableHomepageMultiPing).toBe(false);
    expect(rebased.desktopNodeViewMode).toBe("list");
  });

  it("正在输入的多行文本原样留着（末尾的逗号、换行不被归一化吞掉）", () => {
    const base = draftFromSettings(resolved({}));
    const current = { ...base, hiddenNodesText: "node-a,\n" };
    const next = draftFromSettings(resolved({ surfaceOpacity: 50 }));

    expect(rebaseDraft(current, base, next).hiddenNodesText).toBe("node-a,\n");
  });
});
