import { useQuery } from "@tanstack/react-query";
import { getLoadRecords, getPingRecords } from "@/services/api";

/**
 * 有数据的结果缓存 5 分钟；**空结果不缓存**，下次切到这一档就重新取。
 *
 * 新加的节点刚开始上报时先点了「1 小时」，拿到的是空的；原来这份空结果要留 5 分钟，换到「6 小时」（新请求，有数据了）
 * 再切回来还是「暂无延迟记录」（站长 2026-10-07 截图）。后端对 1 小时档另有 2 分钟服务端缓存，这里管不到。
 */
function recordStaleTime(query: { state: { data: unknown } }): number {
  const records = (query.state.data as { records?: unknown[] } | undefined)?.records;
  return records && records.length > 0 ? 300_000 : 0;
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

export function useLoadRecords(uuid: string, hours = 6, enabled = true) {
  return useQuery({
    queryKey: ["records", "load", uuid, hours],
    queryFn: ({ signal }) => getLoadRecords(uuid, hours, { signal }),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}

// stats 已并入 getPingRecords 的同一次请求(response.stats),不再单独发起查询。
export function usePingRecords(uuid: string, hours = 6, enabled = true) {
  return useQuery({
    queryKey: ["records", "ping", uuid, hours],
    queryFn: ({ signal }) => getPingRecords(uuid, hours, { signal }),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}
