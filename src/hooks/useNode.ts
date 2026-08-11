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
