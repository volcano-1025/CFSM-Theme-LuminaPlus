import { useCallback, useEffect, useRef, useState } from "react";
import { refreshPingHistory, type PingHistoryRefreshResult } from "@/services/api";
import { useVisibleNodeUuids } from "@/hooks/useNode";

export type PingHistoryRefreshStatus = "idle" | "loading" | "done" | "error" | "warn";

/** 刷新结果的提示保留多久，之后按钮回到静默态。 */
const RESULT_HOLD_MS = 4_000;
/**
 * 距上次刷新不到这么久就再点，先提醒一次。
 *
 * 一次刷新是每台节点一趟 `/api/history/all`（线上 7 台约 780 行读），值得按一下就想一下。
 * 而且 30 分钟里数据本来也没长多少：后端历史约 30 秒一行，刷回来的一小时窗口里
 * 有五分之四是上次已经拿到的那些行。
 */
export const RECENT_REFRESH_WINDOW_MS = 30 * 60 * 1000;

/**
 * 这一次点击该不该先提醒。
 *
 * 抽出来是为了能单测：项目里没有 renderHook 的设施，状态机本身跑不了，
 * 但「什么时候提醒」这个判断才是会出错的地方。
 */
export function shouldRemindRecentRefresh(
  lastRefreshedAt: number | null,
  now: number,
): boolean {
  if (lastRefreshedAt == null) return false;
  const elapsed = now - lastRefreshedAt;
  // 负数 = 时钟被往回调过，当作没刷新过，不然提醒会一直卡着。
  if (elapsed < 0) return false;
  return elapsed < RECENT_REFRESH_WINDOW_MS;
}
/** 上次刷新时间要跨刷新保留，否则按 F5 就能绕开提醒。 */
const LAST_REFRESH_STORAGE_KEY = "cfsm-luminaplus:ping-refresh-at:v1";

function readLastRefreshedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_REFRESH_STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    // 未来的时间戳当作没有：改过系统时钟的话，留着会把提醒永久锁死。
    return Number.isFinite(value) && value > 0 && value <= Date.now() ? value : null;
  } catch {
    return null;
  }
}

function writeLastRefreshedAt(value: number): void {
  try {
    window.localStorage.setItem(LAST_REFRESH_STORAGE_KEY, String(value));
  } catch {
    // 隐私模式或配额用尽：提醒退化成「只在本次会话内有效」，不影响刷新本身。
  }
}

export interface PingHistoryRefreshState {
  status: PingHistoryRefreshStatus;
  /** 可刷新的节点数；为 0 时按钮该禁用（节点还没加载出来）。 */
  nodeCount: number;
  lastResult: PingHistoryRefreshResult | null;
  lastRefreshedAt: number | null;
  /** `warn` 状态下距上次刷新过了几分钟（向下取整），用来写提示文案。 */
  minutesSinceLastRefresh: number | null;
  refresh: () => void;
}

/**
 * 首页「刷新延迟数据」按钮的状态机。
 *
 * 只在用户点击时发起请求 —— 首页仍然不许自动查历史，理由见
 * {@link refreshPingHistory} 的注释。同一批请求在途时再点无效（`pendingRef`），
 * 免得连点把请求翻几倍。
 *
 * 距上次刷新不到 {@link RECENT_REFRESH_WINDOW_MS} 时**先提醒不刷新**，再点一次才真的发请求
 * （`armedRef`）—— 是提醒不是禁止，用户坚持要新数据总归拿得到。提醒条收起时解除，
 * 免得「早上点过一次警告、下午随手一点就直接刷了」。
 */
export function usePingHistoryRefresh(): PingHistoryRefreshState {
  const uuids = useVisibleNodeUuids();
  const [status, setStatus] = useState<PingHistoryRefreshStatus>("idle");
  const [lastResult, setLastResult] = useState<PingHistoryRefreshResult | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [minutesSinceLastRefresh, setMinutesSinceLastRefresh] = useState<number | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 已经提醒过、下一次点击放行。 */
  const armedRef = useRef(false);
  const lastRefreshedAtRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const stored = readLastRefreshedAt();
    if (stored != null) {
      lastRefreshedAtRef.current = stored;
      setLastRefreshedAt(stored);
    }
    return () => {
      mountedRef.current = false;
      if (holdTimerRef.current != null) clearTimeout(holdTimerRef.current);
    };
  }, []);

  const settle = useCallback((next: PingHistoryRefreshStatus) => {
    if (!mountedRef.current) return;
    setStatus(next);
    if (holdTimerRef.current != null) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      // 提醒条一收，「再点一次」的授权也跟着过期。
      armedRef.current = false;
      if (mountedRef.current) setStatus("idle");
    }, RESULT_HOLD_MS);
  }, []);

  const refresh = useCallback(() => {
    if (pendingRef.current || uuids.length === 0) return;

    const previous = lastRefreshedAtRef.current;
    const now = Date.now();
    if (!armedRef.current && shouldRemindRecentRefresh(previous, now)) {
      armedRef.current = true;
      setMinutesSinceLastRefresh(Math.floor((now - previous!) / 60_000));
      settle("warn");
      return;
    }

    armedRef.current = false;
    pendingRef.current = true;
    setStatus("loading");

    void refreshPingHistory(uuids)
      .then((result) => {
        if (!mountedRef.current) return;
        setLastResult(result);
        // 一台都没成功就不算「刷新过」——否则提示会变成「上次刷新 23:44，4 台失败」，
        // 读起来像是刷成功了只是有几台掉队。
        if (result.succeeded > 0) {
          const at = Date.now();
          lastRefreshedAtRef.current = at;
          writeLastRefreshedAt(at);
          setLastRefreshedAt(at);
        }
        // 一台都没成功才算失败；部分失败仍然回灌了数据，按成功提示但把数字带出去。
        settle(result.succeeded > 0 ? "done" : "error");
      })
      .catch(() => {
        settle("error");
      })
      .finally(() => {
        pendingRef.current = false;
      });
  }, [settle, uuids]);

  return {
    status,
    nodeCount: uuids.length,
    lastResult,
    lastRefreshedAt,
    minutesSinceLastRefresh,
    refresh,
  };
}
