type AssetsPageModule = typeof import("@/pages/Assets");

let assetsPagePromise: Promise<AssetsPageModule> | null = null;

/** 路由加载与首页预取共用同一个 Promise；失败后允许下一次重新加载。 */
export function loadAssetsPage(): Promise<AssetsPageModule> {
  assetsPagePromise ??= import("@/pages/Assets").catch((error) => {
    assetsPagePromise = null;
    throw error;
  });
  return assetsPagePromise;
}

export function preloadAssetsPage() {
  void loadAssetsPage().catch(() => {
    // 预取失败不影响当前页面；真正进入路由时 loadAssetsPage 会重新尝试。
  });
}
