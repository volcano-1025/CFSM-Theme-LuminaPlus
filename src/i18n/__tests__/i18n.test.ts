// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applySiteLanguage,
  getLanguage,
  loadLanguage,
  readBackendLanguagePreference,
  resolveLanguage,
  setLanguage,
  t,
} from "@/i18n";
import { en } from "@/i18n/messages/en";
import { es } from "@/i18n/messages/es";
import { zh } from "@/i18n/messages/zh";

describe("resolveLanguage", () => {
  it("uses the site default when it names a language", () => {
    expect(resolveLanguage("zh", ["en-US"])).toBe("zh");
    expect(resolveLanguage("EN", ["zh-CN"])).toBe("en");
    expect(resolveLanguage("es", ["zh-CN"])).toBe("es");
  });

  it("follows the browser for auto, like the built-in theme", () => {
    expect(resolveLanguage("auto", ["es-MX", "en"])).toBe("es");
    expect(resolveLanguage("auto", ["zh-TW"])).toBe("zh");
    expect(resolveLanguage("auto", ["fr-FR", "zh-CN"])).toBe("zh");
    expect(resolveLanguage("auto", ["fr-FR", "de"])).toBe("en");
    // 老后端不下发、或值认不出：按 auto 处理。
    expect(resolveLanguage("", ["es"])).toBe("es");
    expect(resolveLanguage("jp", [])).toBe("en");
  });

  it("puts the visitor's own choice from the backend's language switch first", () => {
    // 后台页面 / 内置主题顶上的 EN / 中 / ES 存在 language_preference，压过站点默认和浏览器。
    expect(resolveLanguage("zh", ["zh-CN"], "en")).toBe("en");
    expect(resolveLanguage("auto", ["zh-CN"], "es")).toBe("es");
    expect(resolveLanguage("en", ["zh-CN"], null)).toBe("en");
  });
});

describe("t", () => {
  // 英语 / 西语文案按需下载，先装好再测切换。
  beforeAll(async () => {
    await Promise.all([loadLanguage("en"), loadLanguage("es")]);
  });
  afterEach(() => setLanguage("zh"));

  it("switches language and fills in parameters", () => {
    expect(getLanguage()).toBe("zh");
    expect(t("renewal.expiresIn", { n: 3 })).toBe("3 天后到期");
    setLanguage("en");
    expect(t("renewal.expiresIn", { n: 3 })).toBe("Expires in 3 d");
    setLanguage("es");
    expect(t("renewal.expiresIn", { n: 3 })).toBe("Vence en 3 d");
  });

  it("keeps the same placeholders in every language", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(en[key]), `en ${key}`).toEqual(placeholders(zh[key]));
      expect(placeholders(es[key]), `es ${key}`).toEqual(placeholders(zh[key]));
    }
  });

  it("has no untranslated Chinese left in en / es", () => {
    const cjk = /[一-鿿]/;
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(cjk.test(en[key]), `en ${key}: ${en[key]}`).toBe(false);
      expect(cjk.test(es[key]), `es ${key}: ${es[key]}`).toBe(false);
    }
  });
});

describe("backend language preference", () => {
  afterEach(() => {
    window.localStorage.removeItem("language_preference");
    setLanguage("zh");
  });

  it("reads the key the backend's own frontend writes", () => {
    expect(readBackendLanguagePreference()).toBeNull();
    window.localStorage.setItem("language_preference", "EN");
    expect(readBackendLanguagePreference()).toBe("en");
    // 存的是 auto：等于没选，交给站点默认。
    window.localStorage.setItem("language_preference", "auto");
    expect(readBackendLanguagePreference()).toBeNull();
  });

  it("lets the stored choice override the site default when the config arrives", async () => {
    window.localStorage.setItem("language_preference", "es");
    await applySiteLanguage("zh");
    expect(getLanguage()).toBe("es");
    window.localStorage.removeItem("language_preference");
    await applySiteLanguage("zh");
    expect(getLanguage()).toBe("zh");
  });
});

describe("loading messages on demand", () => {
  afterEach(() => {
    window.localStorage.removeItem("language_preference");
  });

  it("stays in Chinese until the other language has arrived, then switches", async () => {
    // 全新的模块实例：这里英语文案还没下载过。
    vi.resetModules();
    const fresh = await import("@/i18n");
    expect(fresh.t("expire.today")).toBe(zh["expire.today"]);

    const applied = fresh.applySiteLanguage("en");
    // 还没到：语言没切，文案仍是中文，不会出现「语言是英语、字是中文」的一拍。
    expect(fresh.getLanguage()).toBe("zh");
    expect(fresh.t("expire.today")).toBe(zh["expire.today"]);

    await applied;
    expect(fresh.getLanguage()).toBe("en");
    expect(fresh.t("expire.today")).toBe(en["expire.today"]);
    fresh.setLanguage("zh");
  });

  it("does not switch if the wanted language changed while loading", async () => {
    vi.resetModules();
    const fresh = await import("@/i18n");
    const applied = fresh.applySiteLanguage("es");
    // 下载途中访客在后台切回了中文。
    window.localStorage.setItem("language_preference", "zh");
    await applied;
    expect(fresh.getLanguage()).toBe("zh");
  });
});
