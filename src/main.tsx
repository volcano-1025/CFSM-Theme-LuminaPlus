import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/index.css";
import { App } from "./App";
import { initLanguage } from "./i18n";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
const root = rootEl;

async function bootstrap() {
  // 站点配置到手之前（加载圈、读配置失败、人机验证）先按访客选过的语言 / 浏览器语言显示；
  // 配置一到按后台「默认语言」重新定，见 api.ts 的 getPublic。
  // 非中文访客要先下载那种语言的文案，和下面的初始化并行，渲染前等它（中文当场完成）。
  const languageReady = initLanguage();
  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("mock") === "1"
  ) {
    const { installDevMockApi } = await import("./dev/mockApi");
    installDevMockApi();
    // mock 没有 WebSocket：只在这里保留快照轮询，线上产物成功加载后不再定时拉 /api/servers。
    const { setDevSnapshotPolling } = await import("./services/wsStore");
    setDevSnapshotPolling(true);
  }

  await languageReady;
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
