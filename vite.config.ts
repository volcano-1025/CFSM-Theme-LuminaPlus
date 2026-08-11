import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 开发用占位图：旗帜和 OS 图标平时由后端默认皮肤提供，本地没有后端时会整屏碎图。
 * `<img>` 不走 fetch，拦不到，所以放在 dev server 中间件里；不进产物。
 */
function devHostAssets(): Plugin {
  return {
    name: "cfsm-dev-host-assets",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        if (!path.startsWith("/flags/") && !path.startsWith("/os-icons/")) {
          next();
          return;
        }
        const label = (path.split("/").pop() ?? "").replace(/\.\w+$/, "").slice(0, 4);
        res.setHeader("Content-Type", "image/svg+xml");
        res.end(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24">` +
            `<rect width="32" height="24" rx="3" fill="#5b6472"/>` +
            `<text x="16" y="16" font-size="8" fill="#fff" text-anchor="middle">${label}</text>` +
            `</svg>`,
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devHostAssets()],
  // CF-Server-Monitor 的主题构建产物只能是 index.html + assets/，并且会被挂到站点根路径或
  // GitHub Pages 的子路径下，因此资源引用必须是相对路径。Worker 会把 `./assets/` 重写成
  // `/assets/` 再代理到主题仓库。
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // 与 CSS 实际基线对齐:全站大量 color-mix()/oklch(需 Chrome 111 / Safari 16.2+),
    // JS 没必要为更老的引擎转译。
    target: ["es2022", "chrome111", "safari16.2", "firefox113"],
    assetsDir: "assets",
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, "/");
          if (!normalized.includes("/node_modules/")) return;

          if (
            /\/node_modules\/(?:react|react-dom|react-router|react-router-dom)\//.test(
              normalized,
            )
          ) {
            return "react";
          }
          if (normalized.includes("/node_modules/@tanstack/react-query/")) {
            return "query";
          }
          if (/\/node_modules\/(?:uplot|uplot-react)\//.test(normalized)) {
            return "charts";
          }
          if (normalized.includes("/node_modules/zod/")) {
            return "validation";
          }
        },
      },
    },
  },
});
