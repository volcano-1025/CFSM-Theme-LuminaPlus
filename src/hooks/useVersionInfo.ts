import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { fetchLatestThemeVersion, readCurrentThemeVersion } from "@/services/versionCheck";
import { isNewerVersion } from "@/utils/versionCompare";

export interface VersionStatus {
  /** 正在跑的版本；拿不到是 null。页脚只在悬停名字时显示它。 */
  current: string | null;
  /** 有新版时是新版本号，否则 null。只对登录站长有值（见 versionCheck 的说明）。 */
  update: string | null;
}

/** 页脚用的版本信息：当前版本（悬停提示）与「有新版本」标签。 */
export function useVersionInfo(): { backend: VersionStatus; theme: VersionStatus } {
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

  const backendCurrent = config?.version || null;
  const backendLatest = config?.latestVersion || null;
  return {
    backend: {
      current: backendCurrent,
      update: isOwner && isNewerVersion(backendLatest, backendCurrent) ? backendLatest : null,
    },
    theme: {
      current: themeCurrent,
      update:
        isOwner && themeLatest && isNewerVersion(themeLatest, themeCurrent) ? themeLatest : null,
    },
  };
}
