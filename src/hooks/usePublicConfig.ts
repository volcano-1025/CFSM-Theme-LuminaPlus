import { useQuery } from "@tanstack/react-query";
import { getPublic } from "@/services/api";
import type { PublicConfig } from "@/types/cfsm";

export function usePublicConfig() {
  return useQuery<PublicConfig>({
    queryKey: ["public"],
    queryFn: ({ signal }) => getPublic({ signal }),
    staleTime: 60_000,
  });
}

/**
 * 后端下发的首页延迟窗口跨度（毫秒），取自 `/api/config` 的 `latency_window.hours`。
 *
 * 后端还没下发这个字段（老后端 / 尚未上线）时返回 `undefined` —— 调用方（`useNodeCardModel`）
 * 把它当 `buildPingBuckets` 的 `windowMs`，缺席就回退到「从数据时间戳自推跨度」。`points`
 * 暂不用（格数仍固定 `HOMEPAGE_PING_BUCKET_COUNT`）。
 */
export function useLatencyWindowMs(): number | undefined {
  const { data } = usePublicConfig();
  const hours = data?.latencyWindow?.hours;
  return typeof hours === "number" && Number.isFinite(hours) && hours > 0
    ? hours * 60 * 60 * 1000
    : undefined;
}
