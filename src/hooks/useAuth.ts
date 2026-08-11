import { useQuery } from "@tanstack/react-query";
import { getMe } from "@/services/api";

export function useAuth() {
  return useQuery({
    queryKey: ["me"],
    queryFn: ({ signal }) => getMe({ signal }),
    staleTime: 30_000,
    // 后台在新标签页登录后，返回时必须立即校验。
    refetchOnWindowFocus: "always",
  });
}
