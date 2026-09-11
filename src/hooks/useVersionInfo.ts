import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import {
  fetchLatestThemeVersion,
  getSeenUpdateVersions,
  markUpdateVersionsSeen,
  readCurrentThemeVersion,
  subscribeSeenUpdateVersions,
} from "@/services/versionCheck";
import { isNewerVersion } from "@/utils/versionCompare";

export interface VersionStatus {
  /** 正在跑的版本；拿不到是 null。 */
  current: string | null;
  /** 有新版时是新版本号，否则 null。只对登录站长有值（见 versionCheck 的说明）。 */
  update: string | null;
}

/**
 * 页脚的版本号与「有新版本」提醒。页脚与右上角快捷栏各用一份，查主题最新版的请求靠
 * react-query 的同一个 key 合并，「看过了」的状态走 versionCheck 里的小 store 同步。
 */
export function useVersionInfo() {
  const { data: config } = usePublicConfig();
  const { data: me } = useAuth();
  const isOwner = me?.logged_in === true;
  const themeCurrent = useMemo(() => readCurrentThemeVersion(), []);
  const { data: themeLatest } = useQuery({
    queryKey: ["theme-latest-version"],
    queryFn: () => fetchLatestThemeVersion(),
    enabled: isOwner && themeCurrent != null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const seen = useSyncExternalStore(
    subscribeSeenUpdateVersions,
    getSeenUpdateVersions,
    getSeenUpdateVersions,
  );

  const backendCurrent = config?.version || null;
  const backendLatest = config?.latestVersion || null;
  const backendUpdate =
    isOwner && isNewerVersion(backendLatest, backendCurrent) ? backendLatest : null;
  const themeUpdate =
    isOwner && themeLatest && isNewerVersion(themeLatest, themeCurrent) ? themeLatest : null;
  const hasUnseenUpdate =
    (backendUpdate != null && seen.backend !== backendUpdate) ||
    (themeUpdate != null && seen.theme !== themeUpdate);

  const markSeen = useCallback(() => {
    if (!backendUpdate && !themeUpdate) return;
    markUpdateVersionsSeen({
      ...seen,
      ...(backendUpdate ? { backend: backendUpdate } : {}),
      ...(themeUpdate ? { theme: themeUpdate } : {}),
    });
  }, [backendUpdate, seen, themeUpdate]);

  return {
    backend: { current: backendCurrent, update: backendUpdate } satisfies VersionStatus,
    theme: { current: themeCurrent, update: themeUpdate } satisfies VersionStatus,
    hasUnseenUpdate,
    markSeen,
  };
}
