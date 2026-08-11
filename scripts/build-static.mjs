/**
 * 纯静态部署（GitHub Pages 等）的构建后处理。
 *
 * 由 Worker 托管主题时，站点标题、图标、背景图、CSP 都由后端注入，直接 `npm run build` 即可。
 * 静态托管没有这一层注入，所以这里把 .env 里的配置写进 dist/index.html：
 *
 *   API_BASE         必填，后端地址，多个用英文逗号分隔
 *   TITLE            选填，页面标题
 *   BACKGROUND_IMAGE 选填，背景图 URL
 *
 * 用法：`npm run build:github-page`
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const indexPath = resolve(root, "dist/index.html");

function readEnvFile() {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return {};

  const env = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = value;
  }
  return env;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeCssUrl(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/["'()\s]/g, encodeURIComponent);
}

if (!existsSync(indexPath)) {
  throw new Error("dist/index.html 不存在，请先执行 npm run build");
}

const env = { ...readEnvFile(), ...process.env };
const apiBase = (env.API_BASE ?? "").trim();
if (!apiBase) {
  throw new Error(
    "缺少 API_BASE：静态部署必须在 .env 中配置后端地址，例如 API_BASE=https://status.example.com",
  );
}

let html = readFileSync(indexPath, "utf8");

html = html.replace(
  /<meta name="apiBase" content="[^"]*"\s*\/?>/,
  `<meta name="apiBase" content="${escapeHtml(apiBase)}" />`,
);

const title = (env.TITLE ?? "").trim();
if (title) {
  html = html.replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(title)}</title>`);
}

const backgroundImage = (env.BACKGROUND_IMAGE ?? "").trim();
if (backgroundImage) {
  // 与 Worker 注入的背景样式保持一致，让静态站和托管站观感相同。
  const style =
    `<style>body{background-image:url('${escapeCssUrl(backgroundImage)}') !important;` +
    "background-size:cover !important;background-attachment:fixed !important;" +
    "background-position:center !important;}</style>";
  html = html.replace("</head>", `${style}\n</head>`);
}

writeFileSync(indexPath, html);

console.log(`[build:github-page] apiBase = ${apiBase}`);
if (title) console.log(`[build:github-page] title = ${title}`);
if (backgroundImage) console.log("[build:github-page] 已注入背景图");
console.log(
  "[build:github-page] 记得在每个 Workers 的环境变量里把本站域名加进 CORS_ALLOWED_ORIGINS",
);
