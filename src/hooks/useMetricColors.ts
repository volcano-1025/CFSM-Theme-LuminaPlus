import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { clearCssColorCache } from "@/components/node/CanvasStrip";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { useLocalThemeSettings } from "@/hooks/useThemeSettings";
import {
  getLocalThemeSettings,
  resetLocalThemeSettings,
  saveLocalThemeSettings,
} from "@/services/themeSettingsStore";
import { saveThemeOptions } from "@/services/api";
import { getJwtToken } from "@/services/cfsm/config";
import { ApiRequestError } from "@/services/cfsm/http";
import { normalizeThemeSettings } from "@/utils/themeSettings";

// 指标色和暗色深度存进主题设置（站点预设 + 本机覆盖），并通过 CSS 变量全局应用。

export type MetricColorKey =
  | "cpu"
  | "memory"
  | "disk"
  | "load"
  | "swap"
  | "speedIdle"
  | "speedLow"
  | "speedHigh"
  | "speedMax"
  | "trafficUp"
  | "trafficDown";

type MetricColorGroup = "metric" | "speed" | "traffic";

export const METRIC_COLOR_GROUPS: ReadonlyArray<{ id: MetricColorGroup; label: string }> = [
  { id: "metric", label: "卡片配色" },
  { id: "speed", label: "速率热力" },
  { id: "traffic", label: "流量方向" },
];

export const METRIC_COLOR_META: ReadonlyArray<{
  key: MetricColorKey;
  label: string;
  cssVar: string;
  group: MetricColorGroup;
}> = [
  { key: "cpu", label: "CPU", cssVar: "--progress-cpu", group: "metric" },
  { key: "memory", label: "内存", cssVar: "--progress-memory", group: "metric" },
  { key: "disk", label: "磁盘", cssVar: "--progress-disk", group: "metric" },
  { key: "load", label: "负载", cssVar: "--progress-load", group: "metric" },
  { key: "swap", label: "Swap", cssVar: "--progress-swap", group: "metric" },
  { key: "speedIdle", label: "超低速", cssVar: "--speed-idle", group: "speed" },
  { key: "speedLow", label: "低速", cssVar: "--speed-low", group: "speed" },
  { key: "speedHigh", label: "高速", cssVar: "--speed-high", group: "speed" },
  { key: "speedMax", label: "急速", cssVar: "--speed-max", group: "speed" },
  { key: "trafficUp", label: "上行", cssVar: "--traffic-up", group: "traffic" },
  { key: "trafficDown", label: "下行", cssVar: "--traffic-down", group: "traffic" },
];

type MetricColors = Partial<Record<MetricColorKey, string>>;

const SETTINGS_KEY = "metricColors";
const DARK_DEPTH_SETTINGS_KEY = "darkDepth";
const DARK_DEPTH_CACHE_KEY = "cfsm-luminaplus:dark-depth";
const HEX = /^#[0-9a-f]{6}$/;
export const DEFAULT_DARK_DEPTH = 0;

interface PaletteDraft {
  colors: MetricColors;
  darkDepth: number;
}

function toInputHex(value: string): string {
  let v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) v = "#" + [...v.slice(1)].map((c) => c + c).join("");
  return HEX.test(v) ? v : "#888888";
}

/** 从后端 theme_settings 解析出已保存的指标配色（校验 hex 与已知 key）。 */
function readMetricColorsFromSettings(
  settings: Record<string, unknown> | undefined,
): MetricColors {
  const raw = settings?.[SETTINGS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: MetricColors = {};
  for (const { key } of METRIC_COLOR_META) {
    const v = source[key];
    if (typeof v === "string" && HEX.test(v.toLowerCase())) out[key] = v.toLowerCase();
  }
  return out;
}

export function normalizeDarkDepth(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_DARK_DEPTH;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

/** 缺省值 0 就是原有 Dark Dimmed 灰黑；只接受 0–100 的受限黑色深度。 */
export function readDarkDepthFromSettings(
  settings: Record<string, unknown> | undefined,
): number {
  return normalizeDarkDepth(settings?.[DARK_DEPTH_SETTINGS_KEY]);
}

function readPaletteDraft(settings: Record<string, unknown> | undefined): PaletteDraft {
  return {
    colors: readMetricColorsFromSettings(settings),
    darkDepth: readDarkDepthFromSettings(settings),
  };
}

/**
 * 导出用：从一份主题设置里挑出配色相关的键。
 *
 * 设置页的「复制配置 JSON」走 normalizeThemeSettings，那是个白名单，认不得
 * metricColors / darkDepth，直接导出会把取色器里调的卡片配色丢掉。
 * 与默认值相同就不写进快照，避免站点预设里堆一堆无意义的键。
 */
export function pickPaletteSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const { colors, darkDepth } = readPaletteDraft(settings);
  const out: Record<string, unknown> = {};
  if (Object.keys(colors).length > 0) out[SETTINGS_KEY] = colors;
  if (darkDepth !== DEFAULT_DARK_DEPTH) out[DARK_DEPTH_SETTINGS_KEY] = darkDepth;
  return out;
}

// ---- 已应用配色：写 CSS 变量 + 维护 version 让 canvas 卡片即时重绘 ----
let version = 0;
let appliedSig = "__init__";
let appliedDarkDepth: number | null = null;
let rafId: number | null = null;
const listeners = new Set<() => void>();

// 编辑期间以本地预览为准，避免 public config 刷新闪回旧值。
let metricColorEditing = false;

function bumpVersionThrottled() {
  // 合并同一帧的取色事件，避免重复重绘所有卡片。
  if (rafId != null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    version += 1;
    for (const l of listeners) l();
  });
}

/** 把一组配色应用到 <html>（CSS 变量即时覆盖；canvas 经 version 重绘）。相同配色不重复应用。 */
function applyMetricColors(colors: MetricColors) {
  const sig = JSON.stringify(colors ?? {});
  if (sig === appliedSig) return;
  appliedSig = sig;
  const root = document.documentElement;
  for (const { key, cssVar } of METRIC_COLOR_META) {
    const v = colors[key];
    if (v) root.style.setProperty(cssVar, v);
    else root.style.removeProperty(cssVar);
  }
  clearCssColorCache();
  bumpVersionThrottled();
}

/** 只设置强度变量；亮色 token 不引用它，因此调整不会污染浅色模式。 */
function applyDarkDepth(value: number) {
  const depth = normalizeDarkDepth(value);
  if (depth === appliedDarkDepth) return;
  appliedDarkDepth = depth;
  const root = document.documentElement;
  if (depth === DEFAULT_DARK_DEPTH) root.style.removeProperty("--dark-depth");
  else root.style.setProperty("--dark-depth", String(depth));
  clearCssColorCache();
  bumpVersionThrottled();
  try {
    if (depth === DEFAULT_DARK_DEPTH) localStorage.removeItem(DARK_DEPTH_CACHE_KEY);
    else localStorage.setItem(DARK_DEPTH_CACHE_KEY, String(depth));
  } catch {
    // 首帧缓存失败不影响当前预览与后端设置。
  }
}

function applyPalette(palette: PaletteDraft) {
  applyMetricColors(palette.colors);
  applyDarkDepth(palette.darkDepth);
}

/** 供 canvas 卡片（NodeCard）订阅：配色变化时拼进 redrawKey 触发重绘。 */
export function useMetricColorsVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => version,
    () => version,
  );
}

/** 读取每个指标当前生效的 hex（含默认 token），供取色器显示初值。 */
export function readEffectiveColors(): Record<MetricColorKey, string> {
  const styles = getComputedStyle(document.documentElement);
  const out = {} as Record<MetricColorKey, string>;
  for (const { key, cssVar } of METRIC_COLOR_META) out[key] = toInputHex(styles.getPropertyValue(cssVar));
  return out;
}

/** 全局：把后端保存的配色应用到所有访客（在 AppShell 挂载一次）。 */
export function useMetricColorsSync() {
  const { data: config } = usePublicConfig();
  const localSettings = useLocalThemeSettings();
  // 与主题设置同样的口径：站点预设打底，本机覆盖在上。
  // 只读后端会把访客本机保存的配色冲掉（刷新即丢失）。
  const palette = useMemo(
    () => readPaletteDraft({ ...(config?.theme_settings ?? {}), ...localSettings }),
    [config?.theme_settings, localSettings],
  );
  // 站点预设可能定义了配色，config 到达前先保留 index.html 的首帧缓存；
  // 但本机已有覆盖时可以立即应用，不必等网络。
  const ready = config != null || Object.keys(localSettings).length > 0;
  useEffect(() => {
    if (!ready) return;
    if (metricColorEditing) return;
    applyPalette(palette);
  }, [palette, ready]);
}

/** 编辑配色：即时预览并写入本机的主题设置。 */
export function useMetricColorsEditor() {
  const { data: config, refetch: refetchConfig } = usePublicConfig();
  const localSettings = useLocalThemeSettings();
  const savedPalette = useMemo(
    () => readPaletteDraft({ ...(config?.theme_settings ?? {}), ...localSettings }),
    [config?.theme_settings, localSettings],
  );

  // 后端预设（站点级）里的暗色深度。本机覆盖是否要落盘，得和「它要盖住的那个值」比，
  // 而不是和主题默认值比 —— 否则站点预设是 60（深黑）时，选「灰黑」(=默认 0) 会被判成
  // 「与默认相同、无需覆盖」而丢掉本机键，值又弹回站点的 60，表现为「灰黑点不上」。
  const siteDarkDepthRef = useRef(readDarkDepthFromSettings(config?.theme_settings));
  siteDarkDepthRef.current = readDarkDepthFromSettings(config?.theme_settings);

  // 「全部重置」是否可点：只看本机有没有存过配色 / 暗色深度覆盖（跟随站点预设时不该亮）。
  const hasLocalOverrides = useMemo(() => {
    const l = localSettings as Record<string, unknown> | undefined;
    return l?.[SETTINGS_KEY] != null || l?.[DARK_DEPTH_SETTINGS_KEY] != null;
  }, [localSettings]);

  const [draft, setDraft] = useState<PaletteDraft>(savedPalette);
  const draftRef = useRef<PaletteDraft>(savedPalette);
  const savedPaletteRef = useRef<PaletteDraft>(savedPalette);

  // 非编辑状态才接受外部回流;同内容不重置以免多余渲染。
  useEffect(() => {
    if (metricColorEditing) return;
    if (JSON.stringify(savedPaletteRef.current) === JSON.stringify(savedPalette)) return;
    savedPaletteRef.current = savedPalette;
    draftRef.current = savedPalette;
    setDraft(savedPalette);
  }, [savedPalette]);

  // 组件卸载即结束编辑态，本地写入是同步的，没有需要补存的在途请求。
  useEffect(() => {
    return () => {
      metricColorEditing = false;
    };
  }, []);

  const commit = useCallback(
    (next: PaletteDraft) => {
      metricColorEditing = true;
      draftRef.current = next;
      setDraft(next);
      applyPalette(next); // 即时预览

      const nextSettings: Record<string, unknown> = { ...getLocalThemeSettings() };
      if (Object.keys(next.colors).length > 0) nextSettings[SETTINGS_KEY] = next.colors;
      else delete nextSettings[SETTINGS_KEY];
      // 只有和站点预设不同才落本机覆盖；相同则删键、跟随站点（选「灰黑」压 60 也能生效）。
      if (next.darkDepth !== siteDarkDepthRef.current) {
        nextSettings[DARK_DEPTH_SETTINGS_KEY] = next.darkDepth;
      } else {
        delete nextSettings[DARK_DEPTH_SETTINGS_KEY];
      }
      saveLocalThemeSettings(nextSettings);
      savedPaletteRef.current = next;
      metricColorEditing = false;
    },
    [],
  );

  const setColor = useCallback(
    (key: MetricColorKey, hex: string) => {
      const v = hex.toLowerCase();
      if (HEX.test(v)) {
        commit({
          ...draftRef.current,
          colors: { ...draftRef.current.colors, [key]: v },
        });
      }
    },
    [commit],
  );

  const resetColor = useCallback(
    (key: MetricColorKey) => {
      const colors = { ...draftRef.current.colors };
      delete colors[key];
      commit({ ...draftRef.current, colors });
    },
    [commit],
  );

  const setDarkDepth = useCallback(
    (value: number) => {
      commit({ ...draftRef.current, darkDepth: normalizeDarkDepth(value) });
    },
    [commit],
  );

  // 「全部重置」= 丢掉本机覆盖、跟随站点预设：darkDepth 归到站点值（相同即删键）、清空配色覆盖。
  const resetAll = useCallback(
    () => commit({ colors: {}, darkDepth: siteDarkDepthRef.current }),
    [commit],
  );

  // 登录站长可把当前配色（连同其它本机设置）一并写到后端，成为所有设备的默认值。
  const canSaveToBackend = useMemo(() => Boolean(getJwtToken()), []);
  const [savingToBackend, setSavingToBackend] = useState(false);
  const [backendSaveState, setBackendSaveState] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  const saveToBackend = useCallback(async () => {
    setBackendSaveState(null);
    setSavingToBackend(true);
    try {
      // 和设置页「保存到后端」同一份快照口径：归一化白名单 + 配色两部分。
      const merged = { ...(config?.theme_settings ?? {}), ...getLocalThemeSettings() };
      const snapshot = {
        ...normalizeThemeSettings(merged),
        ...pickPaletteSettings(merged),
      };
      await saveThemeOptions(snapshot);
      // 丢本机覆盖、拉最新后端：当前设备立即以刚存的后端配置为准（和设置页一致）。
      resetLocalThemeSettings();
      void refetchConfig();
      setBackendSaveState({ kind: "ok", text: "已保存到后端" });
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0;
      const text =
        status === 401
          ? "登录态已失效，请到 /admin 重新登录"
          : status === 403
            ? "需要先完成人机验证，完成后再点一次"
            : error instanceof Error
              ? error.message
              : "保存到后端失败";
      if (status === 403) void refetchConfig();
      setBackendSaveState({ kind: "error", text });
    } finally {
      setSavingToBackend(false);
    }
  }, [config?.theme_settings, refetchConfig]);

  return {
    colors: draft.colors,
    darkDepth: draft.darkDepth,
    setColor,
    resetColor,
    setDarkDepth,
    resetAll,
    hasLocalOverrides,
    canSaveToBackend,
    savingToBackend,
    backendSaveState,
    saveToBackend,
    // 本地写入不会失败到需要提示的程度，保留字段以兼容调用方。
    saveError: false,
  };
}
