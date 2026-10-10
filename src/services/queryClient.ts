import { QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@/services/api";
import { JWT_STORAGE_KEY, subscribeJwtTokenCleared } from "@/services/cfsm/config";

function shouldRetry(failureCount: number, error: unknown) {
  if (
    error instanceof ApiRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  ) {
    return false;
  }
  return failureCount < 1;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: shouldRetry,
    },
  },
});

/**
 * 站点配置（`["public"]`）只查一次，登录态从它推导。登录态真的变了才重查这一次：
 * 别的标签页在后台登录 / 退出（localStorage 的 storage 事件）、令牌失效被 http 层清掉。
 */
function refreshConfigForAuthChange() {
  void queryClient.invalidateQueries({ queryKey: ["public"] });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === JWT_STORAGE_KEY || event.key === null) refreshConfigForAuthChange();
  });
  subscribeJwtTokenCleared(refreshConfigForAuthChange);
}
