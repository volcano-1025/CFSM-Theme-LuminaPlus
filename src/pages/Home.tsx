import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { NodeGrid } from "@/components/node/NodeGrid";
import { FloatingControls } from "@/components/shell/FloatingControls";
import { PingHealthDialog } from "@/components/shell/PingHealthDialog";
import { Spinner } from "@/components/ui/Spinner";
import { useNodeStoreStatus, useShowThreeNetDetails } from "@/hooks/useNode";
import { usePingDataHealthPrompt } from "@/hooks/usePingDataHealth";
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
  // 刷新状态机放在这一层：快捷栏的按钮和自检弹窗点的是同一次刷新，各自持有一份状态
  // 会让「请求在途」的互斥失效，连点就把请求打两遍。
  const pingRefresh = usePingHistoryRefresh();
  // 站长可以在主题设置里关掉这个提醒（`enablePingHealthPrompt`）；关了就连自检都不跑。
  // 后端那个「输出首页详细 ping/loss」的开关关掉时也不跑：窗口本来就不下发，柱子空是
  // 预期而不是数据坏了，再弹窗就是每次开页都误报一遍。
  const showThreeNetDetails = useShowThreeNetDetails();
  const pingHealth = usePingDataHealthPrompt(
    homeReady && themeSettings.enablePingHealthPrompt && showThreeNetDetails,
  );

  return (
    <div
      className={`home-dashboard relative pb-2${controlsExpanded ? " is-controls-expanded" : ""}`}
    >
      {homeReady && <FloatingControls onExpandedChange={setControlsExpanded} pingRefresh={pingRefresh} />}
      <NodeGrid />
      {pingHealth.summary && (
        <PingHealthDialog
          summary={pingHealth.summary}
          nodeCount={pingHealth.nodeCount}
          estimatedRows={pingHealth.estimatedRows}
          onRefresh={() => {
            pingHealth.dismiss();
            // 弹窗里已经把请求数和读行数写清楚了，用户点的就是确认键，
            // 不该再被「30 分钟内刷新过」的提醒拦一道。
            pingRefresh.refresh({ skipReminder: true });
          }}
          onSkip={pingHealth.dismiss}
        />
      )}
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
