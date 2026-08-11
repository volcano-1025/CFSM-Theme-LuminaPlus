import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // 默认跑在 node 环境；需要 DOM 的用例在文件顶部写 `// @vitest-environment jsdom`。
    setupFiles: ["./vitest.setup.ts"],
  },
});
