import { useCallback, useEffect, useRef, useState } from "react";
import { refreshPingHistory, type PingHistoryRefreshResult } from "@/services/api";
import { useVisibleNodeUuids } from "@/hooks/useNode";

export type PingHistoryRefreshStatus = "idle" | "loading" | "done" | "error";

/** 刷新结果的提示保留多久，之后按钮回到静默态。 */
const RESULT_HOLD_MS = 4_000;

export interface PingHistoryRefreshState {
  status: PingHistoryRefreshStatus;
  /** 可刷新的节点数；为 0 时按钮该禁用（节点还没加载出来）。 */
  nodeCount: number;
  lastResult: PingHistoryRefreshResult | null;
  lastRefreshedAt: number | null;
  refresh: () => void;
}

/**
 * 首页「刷新延迟数据」按钮的状态机。
 *
 * 只在用户点击时发起请求 —— 首页仍然不许自动查历史，理由见
 * {@link refreshPingHistory} 的注释。同一批请求在途时再点无效（`pendingRef`），
 * 免得连点把请求翻几倍。
 */
export function usePingHistoryRefresh(): PingHistoryRefreshState {
  const uuids = useVisibleNodeUuids();
  const [status, setStatus] = useState<PingHistoryRefreshStatus>("idle");
  const [lastResult, setLastResult] = useState<PingHistoryRefreshResult | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
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
      if (mountedRef.current) setStatus("idle");
    }, RESULT_HOLD_MS);
  }, []);

  const refresh = useCallback(() => {
    if (pendingRef.current || uuids.length === 0) return;
    pendingRef.current = true;
    setStatus("loading");

    void refreshPingHistory(uuids)
      .then((result) => {
        if (!mountedRef.current) return;
        setLastResult(result);
        setLastRefreshedAt(Date.now());
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
    refresh,
  };
}
