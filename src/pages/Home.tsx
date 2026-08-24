import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { NodeGrid } from "@/components/node/NodeGrid";
import { FloatingControls } from "@/components/shell/FloatingControls";
import { Spinner } from "@/components/ui/Spinner";
import { useNodeStoreStatus } from "@/hooks/useNode";
import { usePingHistoryRefresh } from "@/hooks/usePingHistoryRefresh";
import { useThemeSettings } from "@/hooks/useThemeSettings";

const ThemeManage = lazy(() =>
  import("@/pages/ThemeManage").then((module) => ({ default: module.ThemeManage })),
);

function HomeDashboard() {
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const themeSettings = useThemeSettings();
  const { hydrated: storeHydrated } = useNodeStoreStatus();
  const homeReady = themeSettings.isReady && storeHydrated;
  // 刷新状态机放在这一层：快捷栏的按钮持有它，各处共享一份状态，
  // 「请求在途」的互斥才生效，连点不会把请求打两遍。
  const pingRefresh = usePingHistoryRefresh();

  return (
    <div
      className={`home-dashboard relative pb-2${controlsExpanded ? " is-controls-expanded" : ""}`}
    >
      {homeReady && <FloatingControls onExpandedChange={setControlsExpanded} pingRefresh={pingRefresh} />}
      <NodeGrid />
    </div>
  );
}

export function Home() {
  const [searchParams] = useSearchParams();
  const isThemeManageView = searchParams.get("view") === "theme-manage";

  // 主题设置只写本机浏览器，不需要登录态；管理后台入口另行跳转 /admin#admin。
  if (isThemeManageView) {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-[60vh] items-center justify-center">
            <Spinner size={24} />
          </div>
        }
      >
        <ThemeManage />
      </Suspense>
    );
  }

  return <HomeDashboard />;
}
