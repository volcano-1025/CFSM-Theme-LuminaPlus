import { getLanguage, getLocale, getMessages, type Language } from "./language";
import { zh, type MessageKey } from "./messages/zh";

export type { MessageKey } from "./messages/zh";
export {
  applySiteLanguage,
  getLanguage,
  getLocale,
  initLanguage,
  LANGUAGES,
  loadLanguage,
  readBackendLanguagePreference,
  resolveLanguage,
  setLanguage,
  useLanguage,
  type Language,
} from "./language";

/**
 * 取当前界面语言的文案。`{name}` 用 `params` 里的同名值替换。
 *
 * 不是 hook：工具函数里也能直接用。语言变了整棵组件树会按语言重新挂载（App.tsx），
 * 组件里 `useMemo` 缓存的文案也会跟着换。
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = getMessages()[key] ?? zh[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * 按当前语言缓存一个格式化器（`Intl.DateTimeFormat` / `NumberFormat` 构造开销大，原来都是模块级常量）。
 * 返回的函数每次调用取当前语言那一份，语言换了就新建一份。
 */
export function memoByLanguage<T>(factory: (locale: string) => T): () => T {
  const cache = new Map<Language, T>();
  return () => {
    const language = getLanguage();
    let value = cache.get(language);
    if (value === undefined) {
      value = factory(getLocale(language));
      cache.set(language, value);
    }
    return value;
  };
}

/** 文本排序用的比较：按当前语言的排序规则（中文按拼音、西语按西语字母表）。 */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, getLocale());
}
