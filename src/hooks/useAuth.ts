import { useMemo } from "react";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { resolveMe } from "@/services/api";

/**
 * 登录态：从站点配置里读，不单独请求（见 resolveMe）。
 * 别的标签页登录 / 令牌失效被清时，queryClient 会把配置重拉一次，这里跟着变。
 */
export function useAuth() {
  const config = usePublicConfig();
  const data = useMemo(() => resolveMe(config.data), [config.data]);
  return { data, isPending: data === undefined && config.isPending };
}
