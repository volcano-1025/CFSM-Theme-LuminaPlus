import { fetchWithTimeout } from "@/utils/abort";

/**
 * 版本号与「有新版本」提醒的数据来源（只用在页脚，见 SiteFooter）。
 *
 * - 后端：`/api/config` 的 `version`；最新版 `last_workers_version` **只在登录后下发**
 *   （后端文档：自定义主题不要依赖匿名请求展示升级提示），所以提醒只给登录站长看。
 * - 主题：当前版本读页面里的 `<meta name="theme-version">`（构建时写入，后端反代主题时原样保留）；
 *   最新版读本仓库 `dist` 分支产物里的同一个 meta —— 发布流程保证 dist 只在正式版推 main 后才更新，
 *   preview 不会让站长看到「有新版」。走 raw.githubusercontent.com（后端 CSP 的 connect-src 默认放行），
 *   只在登录后查，结果在本机缓存 12 小时（失败 1 小时），访客不会多出任何第三方请求。
 */

export const THEME_RELEASE_INDEX_URL =
  "https://raw.githubusercontent.com/volcano-1025/CFSM-Theme-LuminaPlus/dist/index.html";

const LATEST_THEME_CACHE_KEY = "cfsm-luminaplus:theme-latest-version";
const LATEST_THEME_TTL_MS = 12 * 60 * 60 * 1000;
const LATEST_THEME_FAILURE_TTL_MS = 60 * 60 * 1000;
const LATEST_THEME_TIMEOUT_MS = 8_000;

/** `LuminaPlus v1.2.15` → `1.2.15`；读不出返回 null。 */
export function parseThemeVersionMeta(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const match = content.trim().match(/v?(\d+(?:\.\d+)+)$/i);
  return match ? match[1]! : null;
}

/** 当前主题版本（页面里的 theme-version meta）。被裁掉时是 null。 */
export function readCurrentThemeVersion(doc: Document = document): string | null {
  return parseThemeVersionMeta(
    doc.querySelector<HTMLMetaElement>('meta[name="theme-version"]')?.content,
  );
}

/** 从 dist 产物的 index.html 里抠出主题版本。 */
export function extractThemeVersionFromHtml(html: string): string | null {
  const match = html.match(/<meta\s+name=["']theme-version["']\s+content=["']([^"']*)["']/i);
  return match ? parseThemeVersionMeta(match[1]) : null;
}

interface CachedLatestVersion {
  checkedAt: number;
  version: string | null;
  ok: boolean;
}

function readCachedLatest(): CachedLatestVersion | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LATEST_THEME_CACHE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const entry = parsed as Record<string, unknown>;
    if (typeof entry.checkedAt !== "number") return null;
    return {
      checkedAt: entry.checkedAt,
      version: typeof entry.version === "string" ? entry.version : null,
      ok: entry.ok === true,
    };
  } catch {
    return null;
  }
}

function writeCachedLatest(entry: CachedLatestVersion) {
  try {
    window.localStorage.setItem(LATEST_THEME_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // 写不进去就每次打开页面查一次，不影响展示。
  }
}

/** 主题最新发布版本；缓存没过期直接用缓存。查失败时沿用上次知道的版本（没有就是 null）。 */
export async function fetchLatestThemeVersion(now = Date.now()): Promise<string | null> {
  const cached = readCachedLatest();
  if (cached) {
    const ttl = cached.ok ? LATEST_THEME_TTL_MS : LATEST_THEME_FAILURE_TTL_MS;
    if (now - cached.checkedAt >= 0 && now - cached.checkedAt < ttl) return cached.version;
  }

  let version: string | null = null;
  try {
    const response = await fetchWithTimeout(
      THEME_RELEASE_INDEX_URL,
      { cache: "no-store" },
      LATEST_THEME_TIMEOUT_MS,
    );
    if (response.ok) version = extractThemeVersionFromHtml(await response.text());
  } catch {
    // 网络不通 / 被站点自定义的 CSP 挡住：当作这次没查到。
  }

  const ok = version != null;
  const entry = { checkedAt: now, version: version ?? cached?.version ?? null, ok };
  writeCachedLatest(entry);
  return entry.version;
}
