import { describe, expect, it } from "vitest";
import {
  normalizeThemeSettings,
  resolvePreferredAppearance,
  withPreferredAppearance,
} from "@/utils/themeSettings";

describe("后台「默认外观」垫底", () => {
  it("maps the backend vocabulary and ignores anything else", () => {
    expect(resolvePreferredAppearance("dark")).toBe("dark");
    expect(resolvePreferredAppearance("light")).toBe("light");
    expect(resolvePreferredAppearance("auto")).toBe("system");
    expect(resolvePreferredAppearance("")).toBeUndefined();
    expect(resolvePreferredAppearance(undefined)).toBeUndefined();
  });

  it("applies only when neither theme_options nor this device set a default appearance", () => {
    const resolve = (layers: Record<string, unknown>) =>
      normalizeThemeSettings(withPreferredAppearance("dark", layers)).defaultAppearance;

    expect(resolve({})).toBe("dark");
    expect(resolve({ defaultAppearance: "light" })).toBe("light");
    expect(resolve({ defaultAppearance: "system" })).toBe("system");
    // 老后端不下发：维持主题默认（跟随系统）。
    expect(normalizeThemeSettings(withPreferredAppearance(undefined, {})).defaultAppearance).toBe(
      "system",
    );
  });
});
