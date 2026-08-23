import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  retainStore,
  getAllNodeMetaSnapshot,
  getHomeNodeSummariesSnapshot,
  getNodeMetaSnapshot,
  getNodeMetricsSnapshot,
  getNodeTrafficTrendSnapshot,
  getNodeOnlineSummariesSnapshot,
  getVisibleNodeUuidsSnapshot,
  subscribeHomeNodeSummaries,
  subscribeNodeOnlineSummaries,
  subscribeAllNodes,
  subscribeStoreStatus,
  subscribeVisibleNodeUuids,
  subscribeToNodeMeta,
  subscribeToNodeMetrics,
  subscribeToNodeTrafficTrend,
  getStoreStatusSnapshot,
  getSysConfigSnapshot,
  subscribeSysConfig,
  type HomeNodeSummary,
  type NodeOnlineSummary,
} from "@/services/wsStore";
import type { NodeInfo, NodeMetrics, TrafficTrendSample } from "@/types/cfsm";

const noopUnsubscribe = () => undefined;

function useEnsured(enabled = true) {
  useEffect(() => {
    if (enabled) return retainStore();
  }, [enabled]);
}

export function useNodeMeta(uuid: string): NodeInfo | undefined {
  useEnsured();
  return useNodeMetaSnapshot(uuid);
}

function useNodeMetaSnapshot(uuid: string): NodeInfo | undefined {
  const subscribe = useCallback(
    (callback: () => void) => subscribeToNodeMeta(uuid, callback),
    [uuid],
  );
  const getSnapshot = useCallback(() => getNodeMetaSnapshot(uuid), [uuid]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useNodeMetrics(uuid: string, enabled = true): NodeMetrics | undefined {
  useEnsured(enabled);
  return useNodeMetricsSnapshot(uuid, enabled);
}

function useNodeMetricsSnapshot(uuid: string, enabled = true): NodeMetrics | undefined {
  const subscribe = useCallback(
    (callback: () => void) =>
      enabled ? subscribeToNodeMetrics(uuid, callback) : noopUnsubscribe,
    [uuid, enabled],
  );
  const getSnapshot = useCallback(
    () => (enabled ? getNodeMetricsSnapshot(uuid) : undefined),
    [uuid, enabled],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useNodeTrafficTrendSnapshot(
  uuid: string,
): { up: TrafficTrendSample[]; down: TrafficTrendSample[] } {
  const subscribe = useCallback(
    (callback: () => void) => subscribeToNodeTrafficTrend(uuid, callback),
    [uuid],
  );
  const getSnapshot = useCallback(() => getNodeTrafficTrendSnapshot(uuid), [uuid]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useNodeCardSnapshots(uuid: string) {
  useEnsured();
  return {
    meta: useNodeMetaSnapshot(uuid),
    metrics: useNodeMetricsSnapshot(uuid),
    trafficTrend: useNodeTrafficTrendSnapshot(uuid),
  };
}

export function useVisibleNodeUuids(includeHidden = false): string[] {
  useEnsured();
  const getSnapshot = useCallback(
    () => getVisibleNodeUuidsSnapshot(includeHidden),
    [includeHidden],
  );
  return useSyncExternalStore(
    subscribeVisibleNodeUuids,
    getSnapshot,
    getSnapshot,
  );
}

export function useAllNodeMeta(): NodeInfo[] {
  useEnsured();
  return useSyncExternalStore(
    subscribeAllNodes,
    getAllNodeMetaSnapshot,
    getAllNodeMetaSnapshot,
  );
}

export function useHomeNodeSummaries(): HomeNodeSummary[] {
  useEnsured();
  return useSyncExternalStore(
    subscribeHomeNodeSummaries,
    getHomeNodeSummariesSnapshot,
    getHomeNodeSummariesSnapshot,
  );
}

export function useNodeOnlineSummaries(): NodeOnlineSummary[] {
  useEnsured();
  return useSyncExternalStore(
    subscribeNodeOnlineSummaries,
    getNodeOnlineSummariesSnapshot,
    getNodeOnlineSummariesSnapshot,
  );
}

const EMPTY_STORE_STATUS = {
  failureStreak: 0,
  hydrated: false,
  nodeInfoError: false,
} as const;

/**
 * 后端 `/api/servers` 下发的 `sysConfig` 里那个开关：**是否输出首页的详细 ping/loss**。
 *
 * 关掉时后端不再下发 `servers[].ping[]` / `loss[]` 这一小时窗口，只剩每台节点当前的
 * 单条 `ping_ct/cu/cm/bd`。主题据此回退：三网那三条线不画（没数据可画），
 * 开页自检也不跑（本来就不下发，不是数据坏了）。老后端没有这个字段，默认按 true 走。
 */
export function useShowThreeNetDetails(): boolean {
  useEnsured();
  const getSnapshot = useCallback(() => getSysConfigSnapshot().show_three_net_details, []);
  return useSyncExternalStore(subscribeSysConfig, getSnapshot, getSnapshot);
}

export function useNodeStoreStatus(enabled = true) {
  useEnsured(enabled);
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeStoreStatus(listener) : noopUnsubscribe),
    [enabled],
  );
  const getSnapshot = useCallback(
    () => (enabled ? getStoreStatusSnapshot() : EMPTY_STORE_STATUS),
    [enabled],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
}
