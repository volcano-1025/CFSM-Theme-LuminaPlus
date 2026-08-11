import { useEffect } from "react";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import {
  applySurfaceCache,
  buildSurfaceCache,
  persistSurfaceCache,
} from "@/utils/background";

/**
 * 同步卡片透明度相关的 CSS 变量与首帧缓存。
 *
 * 背景图由 CF-Server-Monitor 后台外观设置直接注入到 `<body>`，主题不再自己加载背景图。
 */
export function BackgroundLayer() {
  const { surfaceOpacity, isReady } = useThemeSettings();

  useEffect(() => {
    if (!isReady) return;
    const cache = buildSurfaceCache(surfaceOpacity);
    persistSurfaceCache(cache);
    applySurfaceCache(cache);
  }, [isReady, surfaceOpacity]);

  return null;
}
