import { createHashRouter, Navigate, useParams } from "react-router-dom";
import { lazy, Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { RouteErrorFallback } from "@/components/shell/ErrorBoundary";
import { Spinner } from "@/components/ui/Spinner";
import { loadAssetsPage } from "@/services/assetsPageLoader";
import { Home } from "@/pages/Home";

const Instance = lazy(() =>
  import("@/pages/Instance").then((m) => ({ default: m.Instance })),
);
const Assets = lazy(() =>
  loadAssetsPage().then((m) => ({ default: m.Assets })),
);
const NotFound = lazy(() =>
  import("@/pages/NotFound").then((m) => ({ default: m.NotFound })),
);

function LoadingFallback() {
  return (
    <div className="flex h-[60vh] items-center justify-center">
      <Spinner />
    </div>
  );
}

function suspended(page: ReactNode) {
  return <Suspense fallback={<LoadingFallback />}>{page}</Suspense>;
}

/** 兼容早期 `#/instance/:uuid` 链接。 */
function LegacyInstanceRedirect() {
  const { uuid } = useParams<{ uuid: string }>();
  return <Navigate to={`/server/${uuid ?? ""}`} replace />;
}

// CF-Server-Monitor 的主题路由约定是 hash 路由：首页 `/#/`，详情页 `/#/server/:id`。
// 主题被 Worker 挂在站点根路径下，用 hash 才能避免刷新时打到后端路由。
export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteErrorFallback />,
    children: [
      {
        index: true,
        element: <Home />,
      },
      {
        path: "server/:uuid",
        element: suspended(<Instance />),
      },
      {
        path: "instance/:uuid",
        element: <LegacyInstanceRedirect />,
      },
      {
        path: "assets",
        element: suspended(<Assets />),
      },
      {
        path: "404",
        element: suspended(<NotFound />),
      },
      { path: "*", element: <Navigate to="/404" replace /> },
    ],
  },
]);
