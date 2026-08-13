# CFSM-Theme-LuminaPlus

CF-Server-Monitor 的第三方前端主题（由 Komari 主题 LuminaPlus 移植），构建产物挂到
Workers 上当探针面板用。用户文档见 [README.md](README.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 怎么跑

```bash
npm install
npm run dev          # http://localhost:5173/?mock=1 用内置假数据
npm run typecheck    # tsc -b
npm run lint         # eslint
npm test             # vitest
npm run build        # 产物只含 index.html + assets/
```

## 技术栈

React 19 + TypeScript + Vite 8(rolldown) + Tailwind 4 + TanStack Query + uPlot + zod 3 + vitest 4。

## 目录与约定

- `src/services/cfsm/` — 后端适配层：`config.ts`(apiBase/凭证)、`http.ts`、`mappers.ts`、`wsClient.ts`
- `src/services/api.ts` / `wsStore.ts` / `pingLiveStore.ts` — 查询函数、节点状态 store、首页延迟缓冲区
- `src/hooks/usePingOverview.ts` — 首页延迟/丢包柱状图的取数与分桶
- 注释写“为什么”，中文；改数据层前先看 README 的「与 Komari 版的差异」，那里记着后端能力边界

## 硬约束（违反会出事）

- **首页不许查 `/api/history/all`**：逐节点查历史会让后端 D1 读行翻几十倍。首页只能用
  `/api/servers` 的 `servers[].ping|loss` 窗口 + WebSocket 实时值。详情页读历史是允许的。
- **产物目录只能有 `index.html` 和 `assets/`**，CI 有校验步骤。
- **产物分支（`dist` / `dist-preview`）只追加提交，绝不 force-push**：主题商店的
  `versions[].commitid` 和用户锁定的 SHA 指向历史提交，重写会让旧版本用户失效。
- **第三方主题不能调管理端接口**：主题设置只能存 localStorage，站点级预设走后台
  「外观设置 → 主题自定义配置」。
- 路由是 hash（`/#/`、`/#/server/:id`）；旗帜与 OS 图标走后端 `/flags`、`/os-icons`，不打包。

## 发布流程

1. 改 `package.json` 的 `version`，在 `CHANGELOG.md` 加 `## v<版本号>` 段（第一行会成为
   主题商店的更新日志）
2. `git push origin HEAD:preview` → CI 发布到 `dist-preview` 分支 → **交给用户验收**
3. 用户确认后再 `git push origin main` → CI 发布到 `dist`

未经用户确认不要推 `main`。Workers 对分支地址缓存约 1 小时，验收看到旧版就用
`.../tree/<40 位 SHA>` 绕开；线上跑哪一版看页面源码的 `<meta name="theme-version">`。

## 容易踩的坑

- **Ping 丢包色带**（`PingLossStrip`）靠 `PingChart` 里的 `Y_AXIS_SIZE` /
  `CHART_PADDING_LEFT` / `CHART_PADDING_RIGHT` 三个常量与折线逐像素对齐，宽度取 uPlot 的
  canvas 宽（图表宽度会被量化到 8px 网格，量容器会差几像素）。改轴宽或内边距要两边一起改。
  丢包按样本数加权平均，不能套折线那套保峰降采样。
- **三网模式的两个默认值必须一起给**：开关默认开的同时，`homepageMultiPingTaskIds`
  也要有默认值（电信/联通/移动）。任务 id 不足三条时首页会静默退回单线路，只翻开关等于没开。
- **「复制配置 JSON」导出的是归一化白名单 + 配色两部分**：白名单见 `normalizeThemeSettings()`，
  取色器的 `metricColors` / `darkDepth` 不在其中，由 `pickPaletteSettings()` 单独并进快照。
  配色只导用户改过的项，没改过的沿用主题默认 token（这样主题以后调默认配色，站点会跟着走）
  —— 加新的非白名单设置时记得一并考虑导出。
- **本机设置永远压过后台预设**：合并口径是 `{...后台 theme_options, ...localStorage}`，
  访客存过设置后，站长再改后台 JSON 也传不过去，只能靠设置页的「同步后台配置」清掉本地那份。

## 当前状态

v1.2.3 已发布并在主题商店上架（`dist` = 产物分支）。下一步没有排期的功能，
以线上反馈的修复为主。
