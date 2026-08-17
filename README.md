# CFSM-Theme-LuminaPlus

[CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的第三方主题，
由 [Komari-Theme-LuminaPlus](https://github.com/shanyang242/Komari-Theme-LuminaPlus) 移植而来。

界面与交互沿用 LuminaPlus：大 / 小 / 迷你 / 列表四种卡片、首页总览与分组筛选、
资产与流量统计、实例详情的负载与延迟图表（延迟图带丢包色带）；数据层全部改为
CF-Server-Monitor 的公开 API。

## 怎么用

不用自己构建，也不用另外找地方部署 —— 主题跟着你现有的 Workers 后端跑，二选一：

**① 从主题商店切换（最省事）**

后台 `/admin#admin` → 主题商店 → 找到 **LuminaPlus** → 安装并切换。

**② 填自定义主题 URL**

主题商店里没有、或者想装指定版本时，把下面这行地址填进后台的自定义主题 URL：

```
https://github.com/volcano-1025/CFSM-Theme-LuminaPlus/tree/dist
```

`dist` 是构建产物分支（源码在 `main`，别填错）。想锁定某一版就把 `dist` 换成那一版产物提交的
40 位 SHA（`.../tree/<40 位 SHA>`）—— 锁住之后本仓库怎么更新都不会影响你。
各版本对应的 SHA 在 `dist` 分支的提交记录里，提交标题就是版本号。

两种方式都与后端同源，不需要额外配置。站点标题、图标、背景图、自定义 head / script
由后台「外观设置」注入，主题不覆盖它们。主题自身的设置见页面右上角的设置入口，
存在浏览器本地；要给所有访客统一预设，见下面的「与 Komari 版的差异 → 主题设置存在本地」。

### 更新是手动的

装上之后不会自动升级。出了新版本要自己回后台更新一次：

- **主题商店装的**：回主题商店重新安装 / 更新一次。
- **填 URL 装的**：地址填的是 `tree/dist` 的话，Workers 对分支地址有约一小时缓存，
  过了缓存自然就是新版；等不及就把地址临时换成新版本的 40 位 SHA。地址本来就锁在 SHA 上的，
  必须手动改成新 SHA，否则永远停在旧版。

线上到底跑的哪一版，看页面源码里的 `<meta name="theme-version" content="LuminaPlus v...">`。

### 搭配 Egern 小组件（可选）

用 Egern 的话，还有个配套的 iOS 主屏小组件
[cfsm-egern-widget](https://github.com/volcano-1025/cfsm-egern-widget)：
在 Egern 配置里加一段 scriptings 和 widgets 记录、填上后端地址，就能在手机主屏上看节点状态，
小 / 中 / 大三种尺寸共用一个脚本。它和本主题互不依赖，装不装都行。

## 自行构建部署（可选）

上面两种方式已经够用，以下适合想自己托管或改代码的人。

### 一、自己发布产物给 Workers 用

1. `npm run build`，产物在 `dist/`（只有 `index.html` 和 `assets/`）。
2. 把 `index.html` 与 `assets/` 提交到自己的 GitHub 仓库
   （本仓库由 CI 自动发布到 `dist` 分支，见下面的「发布与验收」）。
3. 在后台主题商店里填入该仓库的目录地址，或提交到
   [CFSM-Theme-Store](https://github.com/huilang-me/CFSM-Theme-Store)。

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
未登录访客查询超过 24 小时的历史会被后端拒绝，因此详情页对访客只给到 24 小时档位；
登录后可选到 7 天（后端上限）。

## 与 Komari 版的差异

移植过程中受后端能力约束做了这些调整：

- **延迟探测**：CF-Server-Monitor 的探测点固定为电信 / 联通 / 移动 / BD 四条线路，
  对应主题里的四条「线路」。默认开启三网模式（电信 / 联通 / 移动）；关掉后是单线路模式，
  可为每个节点单独指定线路，未指定的显示电信。探测目标与探测方式（ICMP / TCP）都在后台的
  服务器编辑里配置，公开接口不下发，主题读不到也无法展示。
- **首页延迟柱状图不查历史**：`/api/history/all` 会扫该节点整段时间窗口的历史行，
  首页给每台节点每分钟查一次会让后端 D1 读行翻几十倍（后端作者实测约 60 倍，
  30 秒上报约 120 倍）。首页改从这两个来源取数，都不额外查库：
  1. **后端窗口**（Workers 2.8.3 Beta2 起）：`/api/servers` 的 `servers[].ping` /
     `servers[].loss` 直接给出最近一小时 —— 30 个槽位、每 2 分钟一个。首屏就是完整的一小时。
  2. **实时累积**：`/api/servers` 与 WebSocket 里一直都有的 `ping_*` / `loss_*` 当前值，
     用于两次刷新之间补最新的点，以及兜底没有窗口字段的旧版后端（那时需要开着页面攒一小时）。

  每个样本代表「到下一次采样为止」的那段时间，最长延续 5 分钟：后端窗口的最新一格
  常常不落在 2 分钟网格上（实测与上一格相差 4~5 分钟），不延续就会在最右边凭空缺一格。
  窗口里明确下发了 null 的槽位（探测失败）不会被相邻样本填平，仍然留空。

  **节点掉线后柱子转红**：以掉线节点最后一次上报为界，之后的样本一律不采信
  （后端窗口在节点掉线后可能照样按墙钟铺格子、沿用最后一个已知值），整格都在这之后的
  柱子涂红、悬浮显示「离线」。掉线约 2.5 分钟后最右边一格变红，之后每 2.5 分钟往左多一格，
  一小时后整条全红。

  **卡片的丢包率和详情页图表对不上是正常的**：两者数据源不同 —— 卡片用上面那个 2 分钟窗口，
  详情页读的是 30 秒一行的历史。实测后端并不是把历史行聚合成窗口，而是每 4~6 分钟取一个点
  再向后填充，所以短促的丢包可能整段漏掉（卡片 0%、图表 1.7%），也可能被撑宽而放大
  （卡片 9.7%、图表 5.5%）。两边各自都没算错，要看准确值以详情页为准。

  卡片上两个数字的口径**与原版 Komari 主题一致**：**延迟是最近一次采样的值**（瞬时量，
  看最新的才有意义），**丢包率是最近一小时的加权平均**（丢包本来就是一段时间内的比率，
  单次采样太跳）。柱子是同一小时按 2.5 分钟一格的聚合，所以丢包率数字和柱子同源。
  延迟数字可能比最右边那格新——时间轴是分钟粒度，最多滞后一分钟。
  丢包率是后端给的百分比（例如 6 个包丢 1 个 = 16%），不是「丢了几个包」。

  缓冲区写进 localStorage 保留一小时，旧版后端下刷新也能接上。
  实例详情页的延迟图表仍读历史 —— 那是用户主动打开、单节点一次的请求。
- **今日流量是估算值**：后端历史只保存上/下行**瞬时速率**，没有累计计数器，
  所以今日流量由速率按采样间隔积分得到；采样越稀疏误差越大。单个采样点最多按 10 分钟积分，
  避免探针掉线的时间空洞凭空造出流量。流量配额进度用的是后端的月度累计值，不受此影响。
- **主题设置存在本地**：第三方主题不允许调用管理端接口，因此主题设置页保存在浏览器
  localStorage，只影响当前设备。站长要给所有访客统一预设，请在后台「外观设置」的
  「主题自定义配置」里写 JSON（键名与主题设置一致），主题会把它当作默认值，
  本地设置覆盖其上。设置页的「同步后台配置」会丢掉本机那份、改用后台最新的 JSON。

  **多设备同步**：在本机把设置调好，点设置页右上角的「复制配置 JSON」，粘贴到上面那个
  「主题自定义配置」里保存即可 —— 导出的是完整快照（含配色等设置页之外的项）。
  之后所有设备、所有访客都以它为默认值；某台设备如果已经存过本机设置，后台改的 JSON
  压不过来（本地优先），在那台设备上点一次「同步后台配置」即可跟随。
  主题不能自己写后端设置，所以粘贴这一步必须手动。
- **背景图交给后端**：背景图、站点标题、图标由后台外观设置统一下发，主题只保留卡片不透明度。
- **旗帜与 OS 图标不打包**：按主题规范走后端的 `/flags/<code>.svg` 与 `/os-icons/<file>`；
  跨域部署时会自动拼到 `apiBase` 上。
- **路由改为 hash**：首页 `/#/`，详情页 `/#/server/:id`（旧的 `#/instance/:uuid` 会自动跳转）。
- **管理入口**：跳转到后端的 `/admin#admin`，由内置默认主题接管。
- 后端不提供虚拟化类型、温度、公网 IP 地址（只有 IPv4 / IPv6 可达性）：实例信息页不再列
  「虚拟化」（改列内核版本），其余相关位置显示为空。

## 开发

```bash
npm install
npm run dev         # http://localhost:5173
npm run typecheck   # tsc -b
npm run lint        # eslint
npm test            # vitest
npm run build       # 产物只含 index.html + assets/
```

手边没有后端时，用 `http://localhost:5173/?mock=1` 打开内置假数据（4 台节点，含离线与到期状态）。

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
