import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/index.css";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
const root = rootEl;

async function bootstrap() {
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

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
