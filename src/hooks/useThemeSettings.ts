import { useCallback, useMemo, useSyncExternalStore } from "react";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import {
  getLocalThemeSettings,
  subscribeLocalThemeSettings,
} from "@/services/themeSettingsStore";
import { normalizeThemeSettings, type ResolvedThemeSettings } from "@/utils/themeSettings";

type RawThemeSettings = Parameters<typeof normalizeThemeSettings>[0];

let cachedRemote: RawThemeSettings = undefined;
let cachedLocal: Record<string, unknown> | null = null;
let cachedResolved: ResolvedThemeSettings | null = null;

/**
 * 后端 `theme_options` 作为站点级预设，本地存储作为访客自己的覆盖。
 * 两者都没设置的键落到主题默认值。
 */
function getResolvedThemeSettings(
  remote: RawThemeSettings,
  local: Record<string, unknown>,
): ResolvedThemeSettings {
  if (cachedResolved && remote === cachedRemote && local === cachedLocal) {
    return cachedResolved;
  }
  cachedRemote = remote;
  cachedLocal = local;
  cachedResolved = normalizeThemeSettings({
    ...(remote ?? {}),
    ...local,
  } as RawThemeSettings);
  return cachedResolved;
}

type ThemeSettingsState = ResolvedThemeSettings & {
  /**
   * 服务端 config 到达后为 true。config 请求失败时它也会变 true，
   * 让应用回退到默认值，而不是一直空白。
   */
  isReady: boolean;
  isLoading: boolean;
  isError: boolean;
};

export function useLocalThemeSettings(): Record<string, unknown> {
  const getSnapshot = useCallback(() => getLocalThemeSettings(), []);
  return useSyncExternalStore(subscribeLocalThemeSettings, getSnapshot, getSnapshot);
}

export function useThemeSettings(): ThemeSettingsState {
  const { data: config, isError, isLoading } = usePublicConfig();
  const local = useLocalThemeSettings();
  const hasConfig = config != null;
  const isReady = hasConfig || isError;
  return useMemo(
    () => ({
      ...getResolvedThemeSettings(config?.theme_settings, local),
      isReady,
      isLoading: isLoading && !hasConfig,
      isError,
    }),
    [config?.theme_settings, hasConfig, isError, isLoading, isReady, local],
  );
}
