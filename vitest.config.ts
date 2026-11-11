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
    // Node 25 起自带一个 `localStorage` 全局，会遮住 jsdom 的实现；CI 是 Node 22，没有这个全局。
    // 关掉它，本地和 CI 就是同一套存储（原来要记得手动加 NODE_OPTIONS 才能复现 CI，v1.2.21 因此挂过一次）。
    execArgv: ["--no-experimental-webstorage"],
  },
});
