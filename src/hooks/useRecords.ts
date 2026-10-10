import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getHistorySnapshot,
  normalizeHistoryHours,
  toLoadRecordsResponse,
  toPingRecordsResponse,
  type HistorySnapshot,
} from "@/services/api";

/**
 * 有数据的结果缓存 5 分钟；**空结果不缓存**，下次切到这一档就重新取。
 *
 * 新加的节点刚开始上报时先点了「1 小时」，拿到的是空的；原来这份空结果要留 5 分钟，换到「6 小时」（新请求，有数据了）
 * 再切回来还是「暂无延迟记录」（站长 2026-10-07 截图）。后端对 1 小时档另有 2 分钟服务端缓存，这里管不到。
 */
function recordStaleTime(query: { state: { data: unknown } }): number {
  const rows = (query.state.data as HistorySnapshot | undefined)?.rows;
  return rows && rows.length > 0 ? 300_000 : 0;
}

const RECORD_QUERY_OPTIONS = {
  staleTime: recordStaleTime,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  // 每次进详情页都重取一次：`staleTime` 5 分钟本来会让「刚点进来」直接用上次那份，
  // 刚发生的事（站长 2026-09-21 跑的测速）要刷新页面才看得到，而内置主题是一进去就取。
  // 不怕点来点去多发请求：`fetchHistoryRows` 自己还有 20 秒缓存，在途的同一请求也会复用。
  refetchOnMount: "always",
} as const;

/**
 * 详情页一个档位的原始历史。**负载图和 Ping 图订阅的是同一个查询**（键里没有图表类型），各自用 `select` 换算：
 * 两张图选了同一档时只请求一次，从负载切到 Ping 不会再查（后端主题规范：ping/loss 历史不单独查询）。
 */
function historyQueryOptions(uuid: string, hours: number, enabled: boolean) {
  return {
    queryKey: ["records", "history", uuid, normalizeHistoryHours(hours)] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => getHistorySnapshot(uuid, hours, { signal }),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  };
}

export function useLoadRecords(uuid: string, hours = 6, enabled = true) {
  const select = useCallback(
    (snapshot: HistorySnapshot) => toLoadRecordsResponse(snapshot, uuid, hours),
    [hours, uuid],
  );
  return useQuery({ ...historyQueryOptions(uuid, hours, enabled), select });
}

// stats 随同一份历史算出来(response.stats),不再单独发起查询。
export function usePingRecords(uuid: string, hours = 6, enabled = true) {
  const select = useCallback(
    (snapshot: HistorySnapshot) => toPingRecordsResponse(snapshot, uuid, hours),
    [hours, uuid],
  );
  return useQuery({ ...historyQueryOptions(uuid, hours, enabled), select });
}
