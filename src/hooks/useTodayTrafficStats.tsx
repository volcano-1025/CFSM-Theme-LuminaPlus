// 含 JSX 的 Provider 放这里，因此文件扩展名为 .tsx；外部导入路径不带扩展名，无需改动调用方。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  queryOptions,
  useQueries,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { useMinuteClock } from "@/hooks/useClock";
import {
  getTodayTrafficRecordRangeHours,
  getTodayTrafficRefreshInterval,
  selectActiveTodayTrafficUuids,
} from "@/hooks/todayTrafficQueryPolicy";
import { getLoadRecords } from "@/services/api";
import {
  buildTodayTrafficRecordSamples,
  summarizeTodayTrafficRecords,
  type TodayTrafficSample,
  type TodayTrafficStat,
} from "@/utils/trafficStats";

// 逐节点请求的并发上限，避免节点多时一次性打满后端。
const NODE_QUERY_CONCURRENCY = 4;
const NODE_REQUEST_TIMEOUT_MS = 8_000;
type TodayTrafficQueryMode = "full" | "summary";

export interface TodayTrafficStatsResponse {
  rows: TodayTrafficStat[];
  samplesByUuid: Record<string, TodayTrafficSample[]>;
  rangeStartMs: number;
  rangeEndMs: number;
  intervalSeconds?: number;
  source: "records";
}

export interface NodeTodayTrafficView {
  available: boolean;
  stat: TodayTrafficStat | null;
  source: TodayTrafficStatsResponse["source"] | undefined;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
  setActive: (active: boolean) => void;
}

interface TodayTrafficNodeQueryState {
  stat: TodayTrafficStat | null;
  source: TodayTrafficStatsResponse["source"] | undefined;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
}

interface TodayTrafficStatsContextValue {
  store: TodayTrafficNodeStore;
  setNodeActive: (uuid: string, active: boolean) => void;
}

const EMPTY_REFETCH = async () => undefined;
const EMPTY_NODE_QUERY_STATE: TodayTrafficNodeQueryState = {
  stat: null,
  source: undefined,
  isPending: true,
  isError: false,
  isFetching: false,
  dataUpdatedAt: 0,
  refetch: EMPTY_REFETCH,
};
const EMPTY_UNSUBSCRIBE = () => undefined;

interface TodayTrafficNodeStore {
  getSnapshot: (uuid: string) => TodayTrafficNodeQueryState;
  subscribe: (uuid: string, listener: () => void) => () => void;
  sync: (
    queryUuids: readonly string[],
    nodeQueries: readonly TodayTrafficNodeQueryState[],
  ) => void;
}

function equalNodeQueryState(
  left: TodayTrafficNodeQueryState | undefined,
  right: TodayTrafficNodeQueryState,
) {
  return Boolean(left) &&
    left?.stat === right.stat &&
    left.source === right.source &&
    left.isPending === right.isPending &&
    left.isError === right.isError &&
    left.isFetching === right.isFetching &&
    left.dataUpdatedAt === right.dataUpdatedAt &&
    left.refetch === right.refetch;
}

function createTodayTrafficNodeStore(): TodayTrafficNodeStore {
  const nodes = new Map<string, TodayTrafficNodeQueryState>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (uuid: string) => {
    for (const listener of listeners.get(uuid) ?? []) listener();
  };

  return {
    getSnapshot: (uuid) => nodes.get(uuid) ?? EMPTY_NODE_QUERY_STATE,
    subscribe: (uuid, listener) => {
      let nodeListeners = listeners.get(uuid);
      if (!nodeListeners) {
        nodeListeners = new Set();
        listeners.set(uuid, nodeListeners);
      }
      nodeListeners.add(listener);
      return () => {
        nodeListeners?.delete(listener);
        if (nodeListeners?.size === 0) listeners.delete(uuid);
      };
    },
    sync: (queryUuids, nodeQueries) => {
      const active = new Set(queryUuids);
      for (const uuid of nodes.keys()) {
        if (active.has(uuid)) continue;
        nodes.delete(uuid);
        notify(uuid);
      }
      for (let index = 0; index < queryUuids.length; index += 1) {
        const uuid = queryUuids[index];
        const next = nodeQueries[index];
        if (!uuid || !next || equalNodeQueryState(nodes.get(uuid), next)) continue;
        nodes.set(uuid, next);
        notify(uuid);
      }
    },
  };
}

const TodayTrafficStatsContext = createContext<TodayTrafficStatsContextValue | null>(null);

/**
 * 首页卡片共享的今日流量上下文：默认不请求；弹层打开后按活跃节点分别查询，
 * 避免旧后端在无人交互时放大请求，也避免悬浮切换改变已有节点的缓存键。
 */
export function TodayTrafficStatsProvider({
  uuids,
  children,
}: {
  uuids: string[];
  children: ReactNode;
}) {
  const now = useMinuteClock();
  const store = useMemo(createTodayTrafficNodeStore, []);
  const [activeUuids, setActiveUuids] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const setNodeActive = useCallback((uuid: string, active: boolean) => {
    setActiveUuids((current) => {
      const next = new Set(current);
      if (active) next.add(uuid);
      else next.delete(uuid);
      if (next.size === current.size && next.has(uuid) === current.has(uuid)) {
        return current;
      }
      return next;
    });
  }, []);
  const queryUuids = useMemo(
    () => selectActiveTodayTrafficUuids(uuids, activeUuids),
    [activeUuids, uuids],
  );
  const nodeQueries = useQueries({
    queries: queryUuids.map((uuid) =>
      getTodayTrafficQueryOptions([uuid], now, "summary"),
    ),
  });
  const nodeQueryStates = useMemo(() => {
    const states: TodayTrafficNodeQueryState[] = [];
    for (let index = 0; index < queryUuids.length; index += 1) {
      const query = nodeQueries[index];
      if (!query) continue;
      states[index] = {
        stat: query.data?.rows[0] ?? null,
        source: query.data?.source,
        isPending: query.isPending,
        isError: query.isError,
        isFetching: query.isFetching,
        dataUpdatedAt: query.dataUpdatedAt,
        refetch: query.refetch,
      };
    }
    return states;
  }, [nodeQueries, queryUuids]);

  useEffect(() => {
    store.sync(queryUuids, nodeQueryStates);
  }, [nodeQueryStates, queryUuids, store]);

  const value = useMemo<TodayTrafficStatsContextValue>(
    () => ({
      store,
      setNodeActive,
    }),
    [setNodeActive, store],
  );

  return (
    <TodayTrafficStatsContext.Provider value={value}>
      {children}
    </TodayTrafficStatsContext.Provider>
  );
}

/** 取单个节点的今日流量统计；未被 Provider 包裹时 available 为 false。 */
export function useNodeTodayTraffic(uuid: string): NodeTodayTrafficView {
  const context = useContext(TodayTrafficStatsContext);
  const store = context?.store;
  const setNodeActive = context?.setNodeActive;
  const setActive = useCallback(
    (active: boolean) => setNodeActive?.(uuid, active),
    [setNodeActive, uuid],
  );
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(uuid, listener) ?? EMPTY_UNSUBSCRIBE,
    [store, uuid],
  );
  const getSnapshot = useCallback(
    () => store?.getSnapshot(uuid) ?? EMPTY_NODE_QUERY_STATE,
    [store, uuid],
  );
  const nodeQuery = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!context) {
    return {
      available: false,
      stat: null,
      source: undefined,
      isPending: false,
      isError: false,
      isFetching: false,
      dataUpdatedAt: 0,
      refetch: EMPTY_REFETCH,
      setActive,
    };
  }
  return {
    available: true,
    stat: nodeQuery.stat,
    source: nodeQuery.source,
    isPending: nodeQuery.isPending,
    isError: nodeQuery.isError,
    isFetching: nodeQuery.isFetching,
    dataUpdatedAt: nodeQuery.dataUpdatedAt,
    refetch: nodeQuery.refetch,
    setActive,
  };
}

export function throwIfSignalAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason !== undefined) throw reason;
  throw new DOMException("Aborted", "AbortError");
}

function localDayStartMs(now: number) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/**
 * 逐节点拉当天历史并估算流量。
 *
 * CF-Server-Monitor 没有跨节点的批量指标接口，只能一台一台查；并发上限用来控制
 * 节点较多时的请求压力。
 */
async function loadTodayTrafficByNode(
  uuids: string[],
  startMs: number,
  endMs: number,
  signal: AbortSignal,
  mode: TodayTrafficQueryMode,
): Promise<Pick<TodayTrafficStatsResponse, "rows" | "samplesByUuid">> {
  throwIfSignalAborted(signal);
  const rows: TodayTrafficStat[] = [];
  const samplesByUuid: Record<string, TodayTrafficSample[]> = {};
  const rangeHours = getTodayTrafficRecordRangeHours(startMs, endMs);
  let failureCount = 0;
  let firstFailure: unknown = null;
  for (let index = 0; index < uuids.length; index += NODE_QUERY_CONCURRENCY) {
    const batch = uuids.slice(index, index + NODE_QUERY_CONCURRENCY);
    const responses = await Promise.allSettled(
      batch.map(async (uuid) => {
        const data = await getLoadRecords(uuid, rangeHours, {
          signal,
          timeout: NODE_REQUEST_TIMEOUT_MS,
        });
        return {
          row: summarizeTodayTrafficRecords(uuid, data.records, startMs, endMs),
          samples:
            mode === "full"
              ? buildTodayTrafficRecordSamples(data.records, startMs, endMs)
              : undefined,
        };
      }),
    );
    throwIfSignalAborted(signal);
    for (let offset = 0; offset < responses.length; offset += 1) {
      const uuid = batch[offset];
      const response = responses[offset];
      if (!uuid || !response) continue;
      // 单节点失败按空数据占位,不拖垮整页;全军覆没才让整页进入错误态。
      if (response.status === "rejected") {
        failureCount += 1;
        firstFailure ??= response.reason;
        rows.push(summarizeTodayTrafficRecords(uuid, [], startMs, endMs));
        if (mode === "full") samplesByUuid[uuid] = [];
        continue;
      }
      rows.push(response.value.row);
      if (response.value.samples) samplesByUuid[uuid] = response.value.samples;
    }
  }
  if (failureCount > 0 && failureCount === uuids.length) {
    throw firstFailure instanceof Error
      ? firstFailure
      : new Error("today traffic estimation failed for all nodes");
  }
  return { rows, samplesByUuid };
}

function getTodayTrafficQueryOptions(
  uuids: string[],
  now: number,
  mode: TodayTrafficQueryMode,
) {
  const stableUuids = [...new Set(uuids)].sort();
  const startMs = localDayStartMs(now);
  const uuidSignature = stableUuids.join(",");

  return queryOptions({
    queryKey: ["traffic-stats", "today", startMs, mode, uuidSignature],
    queryFn: async ({ signal }): Promise<TodayTrafficStatsResponse> => {
      const endMs = Date.now();
      const data = await loadTodayTrafficByNode(stableUuids, startMs, endMs, signal, mode);
      return {
        ...data,
        rangeStartMs: startMs,
        rangeEndMs: endMs,
        source: "records",
      };
    },
    enabled: stableUuids.length > 0,
    staleTime: 60_000,
    refetchInterval: (query) =>
      getTodayTrafficRefreshInterval(
        query.state.data?.source,
        query.state.error != null,
      ),
    refetchOnWindowFocus: "always",
    retry: 1,
  });
}

export function useTodayTrafficStats(
  uuids: string[],
  now: number,
  mode: TodayTrafficQueryMode = "full",
) {
  return useQuery(getTodayTrafficQueryOptions(uuids, now, mode));
}

export function preloadTodayTrafficStats(
  queryClient: QueryClient,
  uuids: string[],
  now = Date.now(),
) {
  if (uuids.length === 0) return Promise.resolve();
  return queryClient.prefetchQuery(getTodayTrafficQueryOptions(uuids, now, "full"));
}
