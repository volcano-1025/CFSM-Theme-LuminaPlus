import type { ThemeSettings } from "@/types/cfsm";

/**
 * 主题设置的本地存储。
 *
 * CF-Server-Monitor 的第三方主题不允许调用管理端接口，`/api/config` 里的 `theme_options`
 * 对主题是只读的。因此这里把用户在主题内的调整存到浏览器本地：
 *
 *   默认值  ←  后端 theme_options  ←  本地覆盖
 *
 * 站长要给所有访客统一预设，就在后台外观设置的「主题自定义配置」里写 JSON；
 * 访客自己的调整只影响自己这台设备。
 */

const STORAGE_KEY = "cfsm-luminaplus:theme-settings";

type Listener = () => void;

const listeners = new Set<Listener>();
let cache: Record<string, unknown> | null = null;

function readStorage(): Record<string, unknown> {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = {};
      return cache;
    }
    const parsed: unknown = JSON.parse(raw);
    cache =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** 本地覆盖项；未被覆盖的键交给后端 theme_options / 主题默认值。 */
export function getLocalThemeSettings(): Record<string, unknown> {
  return readStorage();
}

export function saveLocalThemeSettings(
  settings: ThemeSettings & Record<string, unknown>,
): void {
  cache = { ...settings };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (error) {
    // 隐私模式/配额用尽时写入会失败，本次会话内的设置仍然生效。
    console.warn("[LuminaPlus] 主题设置无法写入本地存储", error);
  }
  emit();
}

export function resetLocalThemeSettings(): void {
  cache = {};
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上，删除失败不影响内存中的重置结果。
  }
  emit();
}

export function subscribeLocalThemeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  for (const listener of listeners) listener();
}

// 另一个标签页改了设置时同步过来，避免多标签页之间状态打架。
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    cache = null;
    emit();
  });
}
