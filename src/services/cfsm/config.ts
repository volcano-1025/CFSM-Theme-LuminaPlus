/**
 * CF-Server-Monitor 运行时配置。
 *
 * 主题有两种部署形态：
 * - 由 Worker 托管（主题商店安装）：与后端同源，`apiBase` 留空即可。
 * - 纯静态托管（GitHub Pages 等）：由 `<meta name="apiBase" content="https://a,https://b">`
 *   指定一个或多个后端；此时后端需要在环境变量里配置 `CORS_ALLOWED_ORIGINS`。
 *
 * 这里同时集中管理 JWT 与 Turnstile 凭证的存取。localStorage 的键名与内置默认主题
 * 保持一致，用户在 /admin 登录后回到本主题即可直接复用登录态。
 */

const API_BASE_META_NAME = "apiBase";

export const JWT_STORAGE_KEY = "jwt_token";
export const TURNSTILE_TOKEN_KEY = "turnstile_token";
export const TURNSTILE_VERIFIED_KEY = "turnstile_verified";

let cachedApiBases: string[] | null = null;

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeBase(value: string): string {
  const raw = stripTrailingSlash(String(value || "").trim());
  if (!raw) return "";
  try {
    // 只保留 origin：文档要求 apiBase 不含路径 / 查询串。
    return stripTrailingSlash(new URL(raw, window.location.href).origin);
  } catch {
    return "";
  }
}

function readMetaApiBases(): string[] {
  if (typeof document === "undefined") return [];
  const content = document
    .querySelector<HTMLMetaElement>(`meta[name="${API_BASE_META_NAME}"]`)
    ?.content?.trim();
  if (!content) return [];
  return content
    .split(",")
    .map((item) => normalizeBase(item))
    .filter(Boolean);
}

/** 后端地址列表，至少含一项；多站部署时按 meta 顺序返回。 */
export function getApiBases(): string[] {
  if (cachedApiBases) return cachedApiBases;

  const fromMeta = readMetaApiBases();
  const bases =
    fromMeta.length > 0
      ? Array.from(new Set(fromMeta))
      : [stripTrailingSlash(window.location.origin)];
  cachedApiBases = bases;
  return bases;
}

export function getPrimaryApiBase(): string {
  return getApiBases()[0] ?? stripTrailingSlash(window.location.origin);
}

export function hasMultipleApiBases(): boolean {
  return getApiBases().length > 1;
}

/** 测试用：清掉 meta 解析缓存。 */
export function resetApiBaseCache(): void {
  cachedApiBases = null;
}

export function toWebSocketBase(base: string): string {
  try {
    const url = new URL(base);
    return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  } catch {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
  }
}

/**
 * 旗帜与 OS 图标由后端默认皮肤提供（`/flags/<code>.svg`、`/os-icons/<file>`），
 * 主题不打包它们。跨域部署时要拼到后端 origin 上，否则静态站会 404。
 */
export function hostAssetUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = getPrimaryApiBase();
  if (!base || base === stripTrailingSlash(window.location.origin)) return normalized;
  return `${base}${normalized}`;
}

/** 管理后台固定由内置默认主题接管，第三方主题只能跳转过去。 */
export function getAdminUrl(): string {
  return `${getPrimaryApiBase()}/admin#admin`;
}

// 统一走 window.localStorage：Node 自带的同名全局在没有 --localstorage-file 时不可用，
// 会在测试环境里遮住 jsdom 的实现。
function readStorage(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // 隐私模式下 localStorage 不可写，降级为匿名访问即可。
  }
}

export function getJwtToken(): string {
  return readStorage(JWT_STORAGE_KEY);
}

export function clearJwtToken(): void {
  writeStorage(JWT_STORAGE_KEY, "");
}

export function getTurnstileToken(): string {
  return readStorage(TURNSTILE_TOKEN_KEY);
}

export function setTurnstileToken(token: string): void {
  writeStorage(TURNSTILE_TOKEN_KEY, token);
}

export function getTurnstileVerified(): string {
  return readStorage(TURNSTILE_VERIFIED_KEY);
}

/** 一次成功验证的凭证有效期约 1 小时，缓存后可省掉重复的人机验证。 */
export function setTurnstileVerified(value: string): void {
  writeStorage(TURNSTILE_VERIFIED_KEY, value);
  if (value) writeStorage(TURNSTILE_TOKEN_KEY, "");
}

export function clearTurnstileCredentials(): void {
  writeStorage(TURNSTILE_TOKEN_KEY, "");
  writeStorage(TURNSTILE_VERIFIED_KEY, "");
}
