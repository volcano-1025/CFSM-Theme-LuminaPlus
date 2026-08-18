import { lazy, Suspense, useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Grid3x3, LayoutGrid, List, Monitor, Palette, RefreshCw, Rows3, Settings, SlidersHorizontal, Sun, Moon } from "lucide-react";
import { Link } from "react-router-dom";
import { usePreferences } from "@/hooks/usePreferences";
import { useViewMode } from "@/hooks/useViewMode";
import { useNodeStoreStatus } from "@/hooks/useNode";
import { useAuth } from "@/hooks/useAuth";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { usePingHistoryRefresh, type PingHistoryRefreshState } from "@/hooks/usePingHistoryRefresh";
import { getAdminUrl } from "@/services/cfsm/config";
import type { NodeViewMode } from "@/utils/themeSettings";
import { clsx } from "clsx";

const MetricColorPicker = lazy(() =>
  import("./MetricColorPicker").then((module) => ({ default: module.MetricColorPicker })),
);

// 悬浮球切换按钮展示"下一档"的图标/文案(点击后会切到的视图),而不是当前视图——
// 与 ThemeManage 里 NODE_VIEW_MODE_OPTIONS 的图标语义保持一致。
const VIEW_MODE_META: Record<NodeViewMode, { icon: typeof LayoutGrid; label: string }> = {
  large: { icon: LayoutGrid, label: "大视图" },
  compact: { icon: Rows3, label: "小视图" },
  mini: { icon: Grid3x3, label: "迷你视图" },
  list: { icon: List, label: "列表视图" },
};

/**
 * 刷新按钮的悬浮说明。
 *
 * 这个按钮会逐台发 `/api/history/all`，成本不该藏着 —— 标题里把节点数写出来，
 * 点之前就知道要打多少个请求。
 */
function buildRefreshTitle({
  status,
  nodeCount,
  lastResult,
  lastRefreshedAt,
}: PingHistoryRefreshState): string {
  if (status === "loading") return `正在拉取 ${nodeCount} 台节点最近 1 小时的延迟历史…`;
  if (status === "error") {
    return lastResult && lastResult.succeeded > 0
      ? `部分节点刷新失败（${lastResult.failed}/${lastResult.requested}），点击重试`
      : "刷新失败，点击重试";
  }

  const base = `刷新延迟数据：拉取 ${nodeCount} 台节点最近 1 小时的真实采样`;
  if (lastRefreshedAt == null) return base;

  const at = new Date(lastRefreshedAt).toLocaleTimeString("zh-CN", { hour12: false });
  const partial =
    lastResult && lastResult.failed > 0 ? `，${lastResult.failed} 台失败` : "";
  return `${base}\n上次刷新 ${at}${partial}`;
}

/** 刷新结束后短暂显示的结果条文案；返回 null 表示这会儿不该显示。 */
function buildRefreshToast({
  status,
  lastResult,
}: PingHistoryRefreshState): string | null {
  if (status === "done") {
    if (!lastResult) return "延迟数据已更新";
    return lastResult.failed > 0
      ? `已更新 ${lastResult.succeeded} 台 · ${lastResult.failed} 台失败`
      : `延迟数据已更新 · ${lastResult.succeeded} 台`;
  }
  if (status === "error") return "刷新失败，点按钮重试";
  return null;
}

const APPEARANCE_OPTIONS = [
  { value: "light", icon: Sun, label: "浅色" },
  { value: "system", icon: Monitor, label: "跟随系统" },
  { value: "dark", icon: Moon, label: "深色" },
] as const;

export function FloatingControls({
  onExpandedChange,
}: {
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const { appearance, setAppearance } = usePreferences();
  const { mode, nextMode, toggleMode } = useViewMode();
  const { data: me } = useAuth();
  const themeSettings = useThemeSettings();
  const { failureStreak } = useNodeStoreStatus();
  const pingRefresh = usePingHistoryRefresh();
  const [collapsed, setCollapsed] = useState(true);
  const [colorsOpen, setColorsOpen] = useState(false);
  const [colorsMounted, setColorsMounted] = useState(false);
  const settingsReady = themeSettings.isReady;
  const showAdmin = settingsReady && themeSettings.enableAdminButton;
  // 主题设置与配色都只保存在本机浏览器（第三方主题不能写后端配置），
  // 因此对所有访客开放，各自调各自的。
  const showThemeManage = settingsReady;
  const showColorPicker = settingsReady;
  const showSyncWarning = failureStreak >= 2;
  const hiddenTabIndex = collapsed ? -1 : undefined;
  const ToggleIcon = collapsed ? ChevronLeft : ChevronRight;
  const ViewIcon = VIEW_MODE_META[nextMode].icon;
  // 只要不在最宽松的大卡默认态,就视为"已切换"，按钮保持高亮。
  const isReducedView = mode !== "large";
  useEffect(() => {
    onExpandedChange?.(false);
    return () => onExpandedChange?.(false);
  }, [onExpandedChange]);

  const refreshTitle = buildRefreshTitle(pingRefresh);
  const refreshToast = buildRefreshToast(pingRefresh);
  const refreshDone = pingRefresh.status === "done";

  const toggleControls = () => {
    // 收起快捷栏时同时结束子面板状态，避免下次展开时调色盘自动复现。
    const nextCollapsed = !collapsed;
    if (nextCollapsed) setColorsOpen(false);
    setCollapsed(nextCollapsed);
    onExpandedChange?.(!nextCollapsed);
  };

  return (
    <div
      className={clsx(
        "floating-controls",
        collapsed && "is-collapsed",
        showSyncWarning && "has-warning",
      )}
    >
      <div className="floating-controls-inner">
        <div className="floating-controls-row">
          <div className="floating-controls-actions" aria-hidden={collapsed}>
            {settingsReady && (
              <>
                <div
                  className="control-group floating-controls-appearance"
                  role="group"
                  aria-label="外观选择"
                >
                  {APPEARANCE_OPTIONS.map(({ value, icon: Icon, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setAppearance(value)}
                      aria-label={label}
                      aria-pressed={appearance === value}
                      title={label}
                      tabIndex={hiddenTabIndex}
                      className={clsx(
                        "control-button grid h-9 w-9 place-items-center",
                        appearance === value && "control-toggle is-active",
                      )}
                    >
                      <Icon size={16} />
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={toggleMode}
                  aria-label="切换卡片视图"
                  aria-pressed={isReducedView}
                  title={`临时切换到${VIEW_MODE_META[nextMode].label}`}
                  tabIndex={hiddenTabIndex}
                  className={clsx(
                    "control-button grid h-9 w-9 place-items-center",
                    isReducedView && "control-toggle is-active",
                  )}
                >
                  <ViewIcon size={16} />
                </button>
                {showColorPicker && (
                  <button
                    type="button"
                    onClick={() => {
                      setColorsMounted(true);
                      setColorsOpen((value) => !value);
                    }}
                    aria-label="卡片配色"
                    aria-pressed={colorsOpen}
                    title="卡片配色"
                    tabIndex={hiddenTabIndex}
                    className={clsx(
                      "control-button grid h-9 w-9 place-items-center",
                      colorsOpen && "control-toggle is-active",
                    )}
                  >
                    <Palette size={16} />
                  </button>
                )}
              </>
            )}
            {showThemeManage && (
              <Link
                to="/?view=theme-manage"
                aria-label="主题设置"
                title="主题设置"
                tabIndex={hiddenTabIndex}
                className="control-button grid h-9 w-9 place-items-center"
              >
                <SlidersHorizontal size={16} />
              </Link>
            )}
            {showAdmin && (
              <a
                href={getAdminUrl()}
                aria-label={me?.logged_in ? "管理" : "后台登录"}
                title={me?.logged_in ? "管理" : "后台登录"}
                tabIndex={hiddenTabIndex}
                className="control-button grid h-9 w-9 place-items-center"
              >
                <Settings size={16} />
              </a>
            )}
          </div>
          <button
            type="button"
            className={clsx(
              "control-button floating-controls-refresh grid h-9 w-9 place-items-center",
              refreshDone && "is-refresh-done",
              pingRefresh.status === "error" && "is-refresh-error",
            )}
            aria-label="刷新延迟数据"
            aria-busy={pingRefresh.status === "loading"}
            title={refreshTitle}
            disabled={pingRefresh.nodeCount === 0 || pingRefresh.status === "loading"}
            onClick={pingRefresh.refresh}
          >
            {refreshDone ? (
              <Check size={16} />
            ) : (
              <RefreshCw
                size={16}
                className={
                  pingRefresh.status === "loading"
                    ? "floating-controls-refresh-spin"
                    : undefined
                }
              />
            )}
          </button>
          <button
            type="button"
            className="control-button floating-controls-trigger grid h-9 w-9 place-items-center"
            aria-label={collapsed ? "展开快捷按钮" : "收起快捷按钮"}
            aria-expanded={!collapsed}
            onClick={toggleControls}
            title={collapsed ? "展开快捷按钮" : "收起快捷按钮"}
          >
            <ToggleIcon size={16} />
            {showSyncWarning && collapsed && (
              <span className="floating-controls-warning-dot" aria-hidden />
            )}
          </button>
        </div>
        {showColorPicker && colorsMounted && (
          <Suspense fallback={null}>
            <MetricColorPicker hidden={collapsed || !colorsOpen} />
          </Suspense>
        )}
        {refreshToast && !colorsOpen && (
          <div
            className={clsx(
              "floating-controls-refresh-toast pointer-events-none flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium shadow-[0_10px_25px_-18px_rgba(0,0,0,0.8)] backdrop-blur",
              refreshDone ? "is-done" : "is-error",
            )}
            role="status"
          >
            {refreshDone ? <Check size={12} /> : <AlertTriangle size={12} />}
            <span>{refreshToast}</span>
          </div>
        )}
        {showSyncWarning && !collapsed && !colorsOpen && !refreshToast && (
          <div className="floating-controls-sync-warning pointer-events-none flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--status-offline)_32%,transparent)] bg-[color-mix(in_srgb,var(--surface-a)_90%,transparent)] px-3 py-1 text-[11px] font-medium text-[var(--status-offline)] shadow-[0_10px_25px_-18px_rgba(0,0,0,0.8)] backdrop-blur">
            <AlertTriangle size={12} />
            <span>实时状态同步异常，当前展示的是最近缓存</span>
          </div>
        )}
      </div>
    </div>
  );
}
