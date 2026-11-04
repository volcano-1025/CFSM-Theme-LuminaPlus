# CFSM-Theme-LuminaPlus

[CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的第三方主题，
由 [Komari-Theme-LuminaPlus](https://github.com/shanyang242/Komari-Theme-LuminaPlus) 移植而来。

大 / 小 / 迷你 / 列表四种卡片，首页总览、分组与地区筛选、资产统计，详情页的系统资源与 Ping 图表（带丢包色带）；
界面支持中文、English、Español。数据全部来自 CF-Server-Monitor 的公开 API。

## 安装

主题跟着你现有的 Workers 后端跑，不用自己构建或另找地方部署，二选一：

- **主题商店**：后台 `/admin#/admin` → 主题商店 → **LuminaPlus** → 安装并切换。
- **自定义主题 URL**：把下面的地址填进后台的自定义主题 URL。

  ```
  https://github.com/volcano-1025/CFSM-Theme-LuminaPlus/tree/dist
  ```

  `dist` 是构建产物分支（源码在 `main`，别填错）。想锁定某一版，把 `dist` 换成那一版产物提交的 40 位 SHA；
  各版本的 SHA 在 `dist` 分支的提交记录里，提交标题就是版本号。

站点标题、图标、背景图、自定义 head / script 由后台「外观设置」下发，主题不覆盖。

### 更新

- **主题商店装的**：回主题商店更新一次。
- **填 `tree/dist` 的**：Workers 对分支地址缓存约一小时，过了缓存自动是新版；等不及就临时换成新版的 SHA。
- **锁在 SHA 上的**：要手动换成新 SHA，否则一直停在旧版。

登录后台后，有新版本时页脚的「LuminaPlus」后面会出现「新版 vX」；鼠标放到页脚的两个名字上能看到当前版本号。
线上跑的是哪一版，也可以看页面源码里的 `<meta name="theme-version">`。版本记录见 [CHANGELOG.md](CHANGELOG.md)。

### 界面语言

和内置主题同一套规则：访客在后台页面或内置主题顶上的 EN / 中 / ES 切换过，就用他选的（只记在他的浏览器里）；
没切换过就按后台「外观设置 → 默认语言」，选「自动」时按浏览器语言（西语、中文以外显示英文）。
节点名、分组、标签、线路名是后台填的，原样显示。

### 搭配 iOS 小组件（可选）

有个配套的 iOS 主屏小组件 [cfsm-widget](https://github.com/volcano-1025/cfsm-widget)，**Egern** 和 **Scriptable** 都能装，
和本主题互不依赖。

## 主题设置

页面右上角快捷栏里的「主题设置」进入，分外观 / 首页 / 卡片 / 花费 / 延迟五组，改完停手就自动保存，没有保存按钮。

- **访客**：设置存在自己的浏览器里，只影响这台设备；只存改过的项，没改过的跟着站点的配置走。
- **登录站长**：改动自动同步到后端（`POST /api/theme_options`），成为所有访客的默认。发之前先读一次后端当前配置、
  只叠上这台设备改过的项，别的设备上改的不会被盖掉。后端配置被别人整份改掉时（比如切到别的主题又切回来），
  页面底部会提示，可以一键恢复上次的设置。
- **「改用后端配置」**：丢掉本机存过的设置，回到后端当前的配置。本机改过的项会一直压着后端，想跟随站点就点它。
- **「复制配置 JSON」**（访客可见）：导出完整配置，粘到后台「外观设置 → 主题自定义配置」，效果和站长同步一样。
- **默认外观**：主题设置里没写时跟随后台「外观设置 → 默认外观」。访客在快捷栏上点过浅色 / 深色就按他点的；
  在设置页改默认外观会立刻生效，快捷栏关掉外观按钮后访客点过的也不再生效。

快捷栏显示哪些按钮在「外观 → 快捷栏」里选（主题设置按钮一直在）；展开 / 收起会记在本机浏览器里。
首页的分组栏和地区栏都可以直接拖动排序（手机上长按再拖），卡片上的线路名可以点开换线路，站长做的这些同样会同步给所有访客。
分组多到一张卡的宽度放不下时，分组栏会往右伸到排序按钮前，还放不下再横向滚动。

**后台改了配置，等一两分钟再看**：后端对外观设置有约 2 分钟的缓存，每个 Worker 实例各存一份。要确认后端到底下发了什么，
在站点页面的控制台跑 `fetch('/api/config').then(r=>r.json()).then(c=>console.log(c.theme_options))`。

## 数据来源与取数

| 主题功能 | 后端接口 |
| --- | --- |
| 站点配置、登录态、主题预设 | `GET /api/config` |
| 节点列表与指标、首页延迟窗口 | `GET /api/servers` |
| 直接打开详情页时那一台 | `GET /api/server?id=` |
| 实时推送 | `GET /api/ws` |
| 详情页的系统资源 / Ping 历史（两张图同一档位共用一次查询） | `GET /api/history/all` |

遵守后端主题开发规范（`theme-ai-prompt.md` 的「消耗铁律」）：

- `/api/config` 整个页面只查一次；`/api/servers` 只在首次进入和切回前台时查，没有定时轮询，数值刷新全走 WebSocket。
  后台新加、删掉的节点要切回前台或刷新页面才看得到。
- 页面一切到后台就断开 WebSocket，切回来立刻重连（后端只要有前端连着，全站探针就约 2 秒上报一次）。
  断线按指数退避重连，连续 10 次失败停手。后台设了「前端实时连接超时」时，到时断开并提示访客是否继续。
- 首页不查历史：卡片上的延迟柱子用 `/api/servers` 下发的约两小时窗口，加上页面开着时 WebSocket 推来的实测值。
  首页和详情页的延迟、丢包对不上是正常的（窗口一格约 6 分钟，详情页约 30 秒一行），以详情页为准。
- 未登录访客只能查 24 小时以内的历史，登录后可选到 7 天。
- 节点在线与否按后端最近 5 分钟有没有收到它的上报判断，不看节点自己的时钟。

## 与 Komari 版的差异

- **延迟线路**：探测点是后端固定的八条（电信 / 联通 / 移动 / BD 和四个自定义槽位），名字跟后台设置走；
  探测目标和方式在后台配，公开接口不下发。多线路模式下首页显示几条可在设置里选（1~8 条），也可以单线路。
  整轮超时画成红格、算进丢包率；没配置的线路不显示。
- **没有「今日流量」和「峰值速度」**：后端历史只有瞬时速率，没有当天的累计计数器，估出来的数不准，干脆不显示。
  剩余流量和配额进度用的是后端的月度累计值，不受影响。
- **背景图、站点标题、图标交给后端**，主题只保留卡片不透明度。
- **旗帜与 OS 图标不打包**，走后端的 `/flags/` 与 `/os-icons/`。
- **路由改为 hash**：首页 `/#/`，详情页 `/#/server/:id`。管理入口跳到后端的 `/admin#/admin`。
- 后端不提供虚拟化类型、温度、公网 IP：实例信息里不列这些。

## 自行构建部署（可选）

**给 Workers 用**：`npm run build`，把 `dist/` 里的 `index.html` 和 `assets/` 提交到自己的仓库，
在后台填该目录的地址，或提交到 [CFSM-Theme-Store](https://github.com/huilang-me/CFSM-Theme-Store)。

**纯静态托管（GitHub Pages 等）**：在项目根目录建 `.env`，然后 `npm run build:github-page`。

```ini
API_BASE=https://status.example.com
# 多后端用英文逗号分隔：API_BASE=https://a.example.com,https://b.example.com
TITLE=我的监控                # 可选，不设则跟随后台站点标题
BACKGROUND_IMAGE=https://example.com/bg.webp
```

还要在**每一个** Workers 的环境变量里加 `CORS_ALLOWED_ORIGINS`（和 `API_SECRET` 同一处），
填上本地开发地址和线上域名，例如 `https://localhost:5173,https://<你的用户名>.github.io`。
跨域部署的私有站点，WebSocket 会带上登录后的 JWT。

## 发布

`.github/workflows/build-theme.yml` 在推送时构建并发布产物：推 `main` 发布到 `dist`（线上地址），
推 `preview` 发布到 `dist-preview`（验收用，在后台用 `.../tree/dist-preview` 或它的 SHA 预览）。

- 发版先改 `package.json` 的 `version`，在 CHANGELOG 加一段 `## v<版本号>`，CI 取该段第一行作为产物提交的说明，
  也就是主题商店里的更新日志（格式 `v<版本号> <更新日志>`）。只想补一条日志时，手动运行 workflow 并勾上 `force`。
- 推 `main` 发布成功后，CI 给这一版的产物提交打上 `v<版本号>` 标签并发一条 GitHub Release（正文是 CHANGELOG 里这一段）。
  想收到更新通知，在仓库页面 Watch → Custom → 勾 Releases。Release 只是通知，主题怎么更新不受影响。
- 产物分支只追加提交、不强推，锁在旧 SHA 的用户和主题商店里登记的历史版本一直可用。
- 产物 `index.html` 里写有 `<meta name="theme-version">`，排查缓存时看它。

## 开发

```bash
npm install
npm run dev         # http://localhost:5173
npm run typecheck
npm run lint
npm test
npm run build       # 产物只含 index.html + assets/
```

- 没有后端时用 `http://localhost:5173/?mock=1` 看内置假数据；加 `&lang=en` / `es` / `zh` / `auto` 看不同语言。
- 连线上后端：在根目录 `.env` 写 `API_BASE=https://你的后端`，后端要把 `http://localhost:5173` 加进跨域白名单。
- 界面文案在 `src/i18n/messages/`（`zh.ts` 是键的来源，`en.ts` / `es.ts` 缺键会类型报错），代码里用 `t("键", { 参数 })`。
- 后端适配集中在 `src/services/`：`cfsm/`（地址与凭证、请求、数据映射、WebSocket）、`api.ts`（查询函数）、
  `wsStore.ts`（节点状态）、`pingLiveStore.ts`（首页延迟缓冲）；站长自动同步在 `src/hooks/useSiteThemeOptions.ts`。

## 致谢

- 原主题：[Komari-Theme-LuminaPlus](https://github.com/shanyang242/Komari-Theme-LuminaPlus)（codex & shark & shanyang）
- 后端：[CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor)
