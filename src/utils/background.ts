import type { Appearance } from "@/utils/themeSettings";

export type ResolvedAppearance = Exclude<Appearance, "system">;

export const DEFAULT_SURFACE_OPACITY = 100;

// 低于此不透明度时才叠加背景可读性遮罩。
export const SURFACE_SCRIM_THRESHOLD = 95;

export function normalizeSurfaceOpacity(value: unknown): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(num)) return DEFAULT_SURFACE_OPACITY;
  return Math.min(100, Math.max(0, Math.round(num)));
}

/** 由卡片不透明度推导 0–16% 的背景遮罩；高于阈值时不绘制。 */
export function computeBackgroundScrim(opacity: unknown): number {
  const resolved = normalizeSurfaceOpacity(opacity);
  if (resolved >= SURFACE_SCRIM_THRESHOLD) return 0;
  const t = (SURFACE_SCRIM_THRESHOLD - resolved) / SURFACE_SCRIM_THRESHOLD; // 取值 0–1
  return Math.round(t * 16);
}

const SURFACE_CACHE_KEY = "cfsm-luminaplus:surface";

/**
 * 首帧就能写进 CSS 的表面样式缓存。
 *
 * 背景图本身由 CF-Server-Monitor 后台的外观设置注入到 `<body>`，主题不参与；
 * 这里只负责卡片不透明度和它派生的可读性遮罩。
 */
interface SurfaceCache {
  v: 2;
  alpha: string;
  scrim: string;
}

export function buildSurfaceCache(surfaceOpacity: unknown): SurfaceCache {
  const alpha = normalizeSurfaceOpacity(surfaceOpacity);
  const scrimPct = computeBackgroundScrim(alpha);
  return {
    v: 2,
    alpha: String(alpha),
    scrim:
      scrimPct > 0 ? `color-mix(in srgb, var(--bg-0) ${scrimPct}%, transparent)` : "",
  };
}

const SURFACE_VAR_NAMES = ["--surface-alpha", "--bg-scrim"] as const;

export function applySurfaceCache(cache: SurfaceCache | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!cache) {
    for (const name of SURFACE_VAR_NAMES) root.style.removeProperty(name);
    return;
  }
  root.style.setProperty("--surface-alpha", cache.alpha);
  if (cache.scrim) root.style.setProperty("--bg-scrim", cache.scrim);
  else root.style.removeProperty("--bg-scrim");
}

export function persistSurfaceCache(cache: SurfaceCache | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (cache) localStorage.setItem(SURFACE_CACHE_KEY, JSON.stringify(cache));
    else localStorage.removeItem(SURFACE_CACHE_KEY);
  } catch {
    // 大不了下次首屏没缓存而已，非致命。
  }
}
