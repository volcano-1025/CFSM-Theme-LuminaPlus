# CFSM-Theme-LuminaPlus

[CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的第三方主题，
由 [Komari-Theme-LuminaPlus](https://github.com/shanyang242/Komari-Theme-LuminaPlus) 移植而来。

界面与交互沿用 LuminaPlus：大 / 小 / 迷你 / 列表四种卡片、首页总览与分组筛选、
资产与流量统计、实例详情的负载与延迟图表；数据层全部改为 CF-Server-Monitor 的公开 API。

## 快速开始

```bash
npm install
npm run dev
```

本地没有后端时，用 `http://localhost:5173/?mock=1` 打开内置的假数据（4 台节点，含离线与到期状态）。

## 部署

### 一、由 Workers 托管（推荐）

1. `npm run build`，产物在 `dist/`（只有 `index.html` 和 `assets/`）。
2. 把 `index.html` 与 `assets/` 提交到自己的 GitHub 仓库。
3. 在后台 `/admin#admin` → 主题商店里填入该仓库的目录地址，或提交到
   [CFSM-Theme-Store](https://github.com/huilang-me/CFSM-Theme-Store)。

这种部署与后端同源，不需要任何额外配置。站点标题、图标、背景图、自定义 head / script
由后台「外观设置」注入，主题不覆盖它们。

### 二、纯静态托管（GitHub Pages 等）

1. 在项目根目录建 `.env`：

   ```ini
   API_BASE=https://status.example.com
   # 多后端用英文逗号分隔：
   # API_BASE=https://a.example.com,https://b.example.com
   TITLE=我的监控
   BACKGROUND_IMAGE=https://example.com/bg.webp
   ```

2. 构建：

   ```bash
   npm run build:github-page
   ```

   它会在 `dist/index.html` 里写入 `<meta name="apiBase">`，并按需注入标题与背景图。

3. 在**每一个** Workers 的环境变量里加上 `CORS_ALLOWED_ORIGINS`（位置与 `API_SECRET` 相同），
   把本地开发地址和线上域名都加进去，否则浏览器会拦截 API 请求与 WebSocket：

   ```
   https://localhost:5173,https://<你的用户名>.github.io
   ```

## 发布与验收

`.github/workflows/build-theme.yml` 会在推送时构建并发布产物，两条分支各走各的：

| 推送到 | 产物分支 | 用途 |
| --- | --- | --- |
| `main` | `dist` | 线上主题地址 |
| `preview` | `dist-preview` | 上线前验收，不影响 `dist` |

验收流程：改动先推 `preview`，等 Actions 跑完，在后台把主题地址临时填成
`https://github.com/<owner>/<repo>/tree/dist-preview` 看效果；确认没问题再合进 `main`。

```bash
git push origin HEAD:preview      # 出预览产物
git push origin main              # 确认后正式发布
```

Workers 对分支引用有约一小时的缓存（`THEME_CACHE_TTL`），验收时若看到旧版本，
把地址换成 40 位 commit SHA（`.../tree/<sha>`）即可绕过缓存 —— 这类地址被视为不可变，
线上也可以一直锁在某个 SHA 上，`dist` 分支怎么更新都不会自动生效。

产物提交的说明就是主题商店里的**版本标题与更新日志**，格式固定为：

```
v<package.json 的 version> <更新日志>

build: <源码 commit>
```

发版流程：改 `package.json` 的 `version`，在 [CHANGELOG.md](CHANGELOG.md) 里加一段
`## v<版本号>`，CI 会取该段的第一行当更新日志。没写就退回用本次源码提交的标题。
想单独补一条日志（产物没变化），在 Actions 里手动运行 workflow，填 `changelog`
并勾上 `force` 即可。

产物 `index.html` 里还会写入 `<meta name="theme-version" content="LuminaPlus v...">`，
线上看页面源码就能确认跑的是哪一版 —— 排查缓存问题时很有用。

产物分支保留历史：每次构建是在分支上**追加**提交，不重建也不强推，
因此锁在旧 SHA 的用户、以及主题商店 `versions[].commitid` 里记录的历史版本
都会一直可用。每次 Actions 日志最后会打印本次产物的 commit，登记版本时直接取用。

## 数据来源

| 主题功能 | 后端接口 |
| --- | --- |
| 站点配置、登录态、主题预设 | `GET /api/config` |
| 节点列表与实时指标、首页延迟窗口 | `GET /api/servers` |
| 实时推送 | `GET /api/ws?subscribe=all` + 通道内 `subscribe` 消息 |
| 实例详情的负载 / 延迟历史、今日流量 | `GET /api/history/all` |

WebSocket 断开时自动退回 5 秒轮询 `/api/servers`；多后端部署下每个后端只订阅属于自己的节点 ID。
未登录访客查询超过 24 小时的历史会被后端拒绝，因此详情页只显示 24 小时以内的档位。

## 与 Komari 版的差异

移植过程中受后端能力约束做了这些调整：

- **延迟探测**：CF-Server-Monitor 的探测点固定为电信 / 联通 / 移动 / BD 四条线路，
  对应主题里的四个「任务」。未单独指定线路的节点默认显示电信；三网模式展示其中三条。
  探测目标在后台的服务器编辑里配置。
- **首页延迟柱状图不查历史**：`/api/history/all` 会扫该节点整段时间窗口的历史行，
  首页给每台节点每分钟查一次会让后端 D1 读行翻几十倍（后端作者实测约 60 倍，
  30 秒上报约 120 倍）。首页改从这两个来源取数，都不额外查库：
  1. **后端窗口**（Workers 2.8.3 Beta2 起）：`/api/servers` 的 `servers[].ping` /
     `servers[].loss` 直接给出最近一小时 —— 30 个槽位、每 2 分钟一个。首屏就是完整的一小时。
  2. **实时累积**：`/api/servers` 与 WebSocket 里一直都有的 `ping_*` / `loss_*` 当前值，
     用于两次刷新之间补最新的点，以及兜底没有窗口字段的旧版后端（那时需要开着页面攒一小时）。

  每个样本代表「到下一次采样为止」的那段时间，最长延续 5 分钟：后端窗口的最新一格
  常常不落在 2 分钟网格上（实测与上一格相差 4~5 分钟），不延续就会在最右边凭空缺一格。
  窗口里明确下发了 null 的槽位（节点掉线、探测失败）不会被相邻样本填平，仍然留空。

  缓冲区写进 localStorage 保留一小时，旧版后端下刷新也能接上。
  实例详情页的延迟图表仍读历史 —— 那是用户主动打开、单节点一次的请求。
- **今日流量是估算值**：后端历史只保存上/下行**瞬时速率**，没有累计计数器，
  所以今日流量由速率按采样间隔积分得到；采样越稀疏误差越大。单个采样点最多按 10 分钟积分，
  避免探针掉线的时间空洞凭空造出流量。流量配额进度用的是后端的月度累计值，不受此影响。
- **主题设置存在本地**：第三方主题不允许调用管理端接口，因此主题设置页保存在浏览器
  localStorage，只影响当前设备。站长要给所有访客统一预设，请在后台「外观设置」的
  「主题自定义配置」里写 JSON（键名与主题设置一致），主题会把它当作默认值，
  本地设置覆盖其上。设置页的「恢复站点默认」会清掉本地覆盖。
- **背景图交给后端**：背景图、站点标题、图标由后台外观设置统一下发，主题只保留卡片不透明度。
- **旗帜与 OS 图标不打包**：按主题规范走后端的 `/flags/<code>.svg` 与 `/os-icons/<file>`；
  跨域部署时会自动拼到 `apiBase` 上。
- **路由改为 hash**：首页 `/#/`，详情页 `/#/server/:id`（旧的 `#/instance/:uuid` 会自动跳转）。
- **管理入口**：跳转到后端的 `/admin#admin`，由内置默认主题接管。
- 后端不提供虚拟化类型、温度、公网 IP 地址（只有 IPv4 / IPv6 可达性），相关位置显示为空。

## 开发

```bash
npm run typecheck   # tsc -b
npm run lint        # eslint
npm test            # vitest
npm run build       # 产物只含 index.html + assets/
```

数据层集中在这几个文件，改后端适配基本只碰它们：

- `src/services/cfsm/config.ts` — apiBase / WebSocket 地址 / JWT / Turnstile 凭证
- `src/services/cfsm/http.ts` — 请求封装、错误体解析、多后端并发
- `src/services/cfsm/mappers.ts` — 后端 Server / 历史行 → 主题展示模型
- `src/services/cfsm/wsClient.ts` — `/api/ws` 订阅与重连
- `src/services/api.ts` — 各页面用到的查询函数
- `src/services/wsStore.ts` — 节点状态 store（列表 + 实时合并 + 轮询兜底）
- `src/services/pingLiveStore.ts` — 首页延迟条的实时缓冲区（含 localStorage 持久化）

## 致谢

- 原主题：[Komari-Theme-LuminaPlus](https://github.com/shanyang242/Komari-Theme-LuminaPlus)（codex & shark & shanyang）
- 后端：[CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor)
