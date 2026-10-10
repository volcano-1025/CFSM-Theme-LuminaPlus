import { useQuery } from "@tanstack/react-query";
import { getPublic } from "@/services/api";
import { DEFAULT_CARRIER_NAMES } from "@/services/cfsm/mappers";
import type { CarrierNames, PublicConfig } from "@/types/cfsm";

export function usePublicConfig() {
  return useQuery<PublicConfig>({
    queryKey: ["public"],
    queryFn: ({ signal }) => getPublic({ signal }),
    // 整个页面生命周期只查一次（后端主题规范）。需要新的一份时由明确的事件触发：站长同步前重拉、
    // 人机验证通过 / 凭证失效、登录态变化（见 queryClient）。
    staleTime: Number.POSITIVE_INFINITY,
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

/**
 * 各条线路的显示名。站长在后端改过（`/api/config` 的 `custom_ct_name`、`node_1_name` 等）就用他改的，
 * 老后端 / 没改过时是 `DEFAULT_CARRIER_NAMES` 那个常量本身 —— 引用稳定，可以直接进
 * useMemo 依赖和缓存键。config 还没到时同样先给默认名，到了之后订阅这个 query 的组件
 * 会重渲染，名字自己换过去。
 */
export function useCarrierNames(): CarrierNames {
  const { data } = usePublicConfig();
  return data?.carrierNames ?? DEFAULT_CARRIER_NAMES;
}
