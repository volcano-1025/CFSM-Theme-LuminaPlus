import { useSyncExternalStore } from "react";
import { zh, type Messages } from "./messages/zh";

/** 主题支持的界面语言，和后端 `/api/config` 的 `default_language` 同一套取值（另有 `auto`）。 */
export type Language = "zh" | "en" | "es";

export const LANGUAGES: readonly Language[] = ["zh", "en", "es"];

/** 各语言给 `Intl` 用的区域：西语跟后端一样用拉美西语（es-419）。 */
const LOCALES: Record<Language, string> = {
  zh: "zh-CN",
  en: "en-US",
  es: "es-419",
};

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * 后端自带前端（内置主题和后台页面顶上的 EN / 中 / ES 切换）把访客选的语言存在这个键里，同一个站点下本主题读得到。
 * 见后端 `src/frontend/utils/constants.js` 的 `STORAGE.LANGUAGE_PREFERENCE`。
 */
const BACKEND_LANGUAGE_STORAGE_KEY = "language_preference";

function asLanguage(value: unknown): Language | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "zh" || normalized === "en" || normalized === "es" ? normalized : null;
}

/** 访客在后端自带前端里亲手选过的语言；没选过（或存的是 auto、读不到）返回 null。 */
export function readBackendLanguagePreference(): Language | null {
  try {
    return asLanguage(window.localStorage.getItem(BACKEND_LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * 换算界面语言，优先级和后端内置主题（`src/frontend/utils/i18n.js` 的 `applyDefaultLanguage`）一样：
 * ① 访客在后台 / 内置主题里亲手选过的语言（`visitorChoice`）；② 后台「默认语言」`zh` / `en` / `es`；
 * ③ `auto`（或缺省、认不出的值）按浏览器：首选里先出现西语就西语、先出现中文就中文，都没有用英文。
 *
 * 站长 2026-10-14 在后台顶上点了 EN，内置主题跟着变、本主题没变 —— 原来只看了 ②③。
 */
export function resolveLanguage(
  defaultLanguage: string | null | undefined,
  languages: readonly string[] = browserLanguages(),
  visitorChoice: Language | null = null,
): Language {
  if (visitorChoice) return visitorChoice;
  const preferred = asLanguage(defaultLanguage);
  if (preferred) return preferred;
  for (const raw of languages) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (value === "es" || value.startsWith("es-")) return "es";
    if (value === "zh" || value.startsWith("zh-")) return "zh";
  }
  return "en";
}

// 默认中文：页面在读到站点配置之前只有加载圈和页脚，语言由 `applySiteLanguage` 在配置到手那一刻定下来；
// 单测不经过入口，保持中文，现有断言不受影响。
let current: Language = "zh";
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function getLocale(language: Language = current): string {
  return LOCALES[language];
}

/**
 * 文案按需加载：中文是键的来源和兜底，跟着入口走；英语、西语各自一个块，用到才下载
 * （原来三份一起进首屏，中文访客白下载约 16 KB gzip）。
 */
const dictionaries: Partial<Record<Language, Messages>> = { zh };
const LOADERS: Record<Exclude<Language, "zh">, () => Promise<Messages>> = {
  en: () => import("./messages/en").then((module) => module.en),
  es: () => import("./messages/es").then((module) => module.es),
};
const loading = new Map<Language, Promise<void>>();

/** 当前语言的文案；那份还没下载到就先给中文（`t` 逐条兜底也是中文）。 */
export function getMessages(language: Language = current): Messages {
  return dictionaries[language] ?? zh;
}

/** 下载某种语言的文案。已经有了立刻完成；失败不留缓存，下次调用重试。 */
export function loadLanguage(language: Language): Promise<void> {
  if (language === "zh" || dictionaries[language]) return Promise.resolve();
  let pending = loading.get(language);
  if (!pending) {
    pending = LOADERS[language]()
      .then((messages) => {
        dictionaries[language] = messages;
      })
      .finally(() => {
        loading.delete(language);
      });
    loading.set(language, pending);
  }
  return pending;
}

/** 等文案块的上限。超过就先按当前语言显示，块到了再换（那时整棵树重挂载一次）。 */
const LANGUAGE_LOAD_WAIT_MS = 4000;

export function setLanguage(language: Language) {
  if (language === current) return;
  current = language;
  if (typeof document !== "undefined") document.documentElement.lang = getLocale(language);
  listeners.forEach((listener) => listener());
}

let siteDefaultLanguage: string | null | undefined = "auto";

function desiredLanguage(): Language {
  return resolveLanguage(siteDefaultLanguage, browserLanguages(), readBackendLanguagePreference());
}

/**
 * 按站点配置的 `default_language`（和访客在后台选过的语言）定界面语言。在解析 `/api/config` 时调用并等它完成，
 * 内容渲染前语言就已经定了，不会先中文再跳。
 *
 * 文案已经在手（中文，或这种语言之前下载过）时当场切换；否则先下载，返回的 Promise 等到切完为止，
 * 最多等 `LANGUAGE_LOAD_WAIT_MS`。下载失败留在当前语言，不让页面卡住。
 */
export function applySiteLanguage(defaultLanguage: string | null | undefined): Promise<void> {
  siteDefaultLanguage = defaultLanguage;
  const target = desiredLanguage();
  if (target === "zh" || dictionaries[target]) {
    setLanguage(target);
    return Promise.resolve();
  }
  const applied = loadLanguage(target).then(
    () => {
      // 下载途中语言可能又变了（别的标签页切了、配置到了）：只在它仍是要的那种时才切。
      if (desiredLanguage() === target) setLanguage(target);
    },
    () => {},
  );
  return Promise.race([
    applied,
    new Promise<void>((resolve) => setTimeout(resolve, LANGUAGE_LOAD_WAIT_MS)),
  ]);
}

/**
 * 页面启动时调用一次：先按访客选过的语言 / 浏览器语言显示（站点配置到手前的加载圈、出错页、人机验证），
 * 并跟着别的标签页里的切换走 —— 后台页面开在另一个标签页，点了 EN / 中 / ES，这边立刻换。
 */
export function initLanguage(): Promise<void> {
  const ready = applySiteLanguage(siteDefaultLanguage);
  if (typeof window === "undefined") return ready;
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== BACKEND_LANGUAGE_STORAGE_KEY) return;
    void applySiteLanguage(siteDefaultLanguage);
  });
  return ready;
}

export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 订阅界面语言。语言变了（站长改了默认语言、重新拉到配置）由 App 整棵树按语言重新挂载，见 App.tsx。 */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}
