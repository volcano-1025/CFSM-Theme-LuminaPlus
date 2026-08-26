# CFSM-Theme-LuminaPlus

CF-Server-Monitor 的第三方前端主题（由 Komari 主题 LuminaPlus 移植），构建产物挂到
Workers 上当探针面板用。用户文档见 [README.md](README.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 怎么跑

```bash
npm install
npm run dev          # http://localhost:5173/?mock=1 用内置假数据；连线上后端写 .env 的 API_BASE
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
- `docs/*.png` — 提交 CFSM-Theme-Store 用的封面与截图，代码里没有任何地方引用，别当垃圾删掉
  （目前还是 v1.1.x 时期的界面，重做要跑无头浏览器截真实产物）
- 注释写“为什么”，中文；改数据层前先看 README 的「与 Komari 版的差异」，那里记着后端能力边界

## 硬约束（违反会出事）

- **首页不许「自动」发起 `/api/history/all` 请求**（v1.2.8 改口径，原来是一概不许）：
  自动轮询仍然禁止 —— 每分钟逐节点查会让后端 D1 读行翻几十倍。允许的只有三条：
  ① 详情页读历史；② 详情页那份结果**回灌**首页缓冲（`backfillPingBuffer`，不额外发请求）；
  ③ **用户点刷新**（`refreshPingHistory`，每台一次 `hours=1`，并发上限 4）—— 右上角那个按钮，
  只有它一个入口了（v1.2.9 的开页自检弹窗在 v1.2.11 删掉了），得是人点的。
  账是这么算的：一台节点一小时的行数 = `3600 ÷ 上报间隔`（30 秒 = 120 行），点一次是各节点之和
  （2026-08-19 线上 8 台约 900 行）；每分钟自动拉一次就是它的 **60 倍**。症结在「自动还是手动」，
  不在「用了历史数据」—— 别把这个数当常量，加节点会变。
  后端对 1 小时档有服务端缓存（响应带 `X-Cache`；2026-08-24 起站长把缓存从 60 秒提到 5 分钟），
  连点不会真的重复读库。
  **不要把这个刷新挂到定时器、可见性变化、或路由进入上** —— 那就变回被禁的那种用法了。
  开页自检（`usePingDataHealthPrompt` / `pingWindowHealth` / `enablePingHealthPrompt` 设置项）
  **已在 v1.2.11 整个删掉**：后端现在直接下发完整窗口、前端也自动按返回内容画跨度，不再需要
  「柱子空了要不要拉一次真实采样」的提示。别再找这些符号，它们不存在了。
  30 分钟内重复点击会先提醒一次、不发请求（`shouldRemindRecentRefresh`），上次刷新时间存
  localStorage 所以 F5 绕不过；这是提醒不是冷却，再点一次照样放行。
- **产物目录只能有 `index.html` 和 `assets/`**，CI 有校验步骤。
- **产物分支（`dist` / `dist-preview`）只追加提交，绝不 force-push**：主题商店的
  `versions[].commitid` 和用户锁定的 SHA 指向历史提交，重写会让旧版本用户失效。
- **第三方主题只有一个后端写入口：`POST /api/theme_options`**（后端文档 2.1.1，
  huilang-me/CF-Server-Monitor 的 `theme-develop.md`）。除它以外不许调任何管理端接口。
  这条口子只写 `appearance_options.theme_options`，不碰 `site_options`、也不覆盖站点标题/
  背景图/CSP/自定义脚本；**仅登录站长可用**（要 Bearer JWT，站点开了全局验证时还要 Turnstile
  凭证，都由 http 层从 localStorage 复用）。设置页的「保存到后端」按钮走它（`saveThemeOptions`
  → `cfsmPost`），成功后自动丢本机覆盖、用刚提交的快照重播草稿。
  **访客配置仍然只进 localStorage** —— 这条没变，写入口是站长专属的便利，不是给访客的。
  站点级预设也仍可走后台「外观设置 → 主题自定义配置」手动粘 JSON（「复制配置 JSON」按钮，
  **登录站长隐藏、只对未登录/纯静态部署显示**），两条路等价，快照口径一致
  （`normalizeThemeSettings` 白名单 + `pickPaletteSettings` 配色）。
  设置页工具栏统一「本机 / 后端」两套词：**保存到本机**（存 localStorage、只这台设备）、
  **保存到后端**（`handleSaveToSite`，写后端、所有设备）、**改用后端配置**
  （`handleRestoreSiteDefaults`，丢本机、拉后端那份）；改这些标签时别只改一处，
  masthead 描述与 README 的「主题设置存在本地」段要一起改。
- 路由是 hash（`/#/`、`/#/server/:id`）；旗帜与 OS 图标走后端 `/flags`、`/os-icons`，不打包。

## 发布流程

1. 改 `package.json` 的 `version`，在 `CHANGELOG.md` 加 `## v<版本号>` 段（第一行会成为
   主题商店的更新日志）
2. `git push origin HEAD:preview` → CI 发布到 `dist-preview` 分支 → **交给用户验收**
3. 用户确认后再 `git push origin main` → CI 发布到 `dist`

未经用户确认不要推 `main`。Workers 对分支地址缓存约 1 小时，验收看到旧版就用
`.../tree/<40 位 SHA>` 绕开；线上跑哪一版看页面源码的 `<meta name="theme-version">`。
**光看 `theme-version` 不够** —— 同一个版本号会有多份预览产物。要确认跑的是哪一份，对
`document.querySelector('script[type=module]').src` 里的 `index-<hash>.js`，和
`git ls-tree -r --name-only <产物 SHA> | grep assets/index-` 比。2026-08-23 栽过：修完推了
新预览，站长看的还是上一版产物，反馈「还是没修好」，白查了一轮。

**同一个版本号不要推两次 `main`**：CI 的发布条件是「产物有没有变化」，不看版本号，于是
`dist` 上会留下两条同名提交，主题商店的版本列表就出现两个一样的版本（v1.2.9 就是这么来的：
`4b0192e` 是半成品、`40843e5` 才是完整版）。产物分支只追加不改写，删不掉，只能避免。
要再推一次就先改 `package.json` 的 `version`。CI 目前**没有**这个守卫。

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
  访客存过设置后，站长再改后台 JSON 也传不过去，只能靠设置页的「改用后端配置」清掉本地那份。
- **本机覆盖要不要落盘，得和「站点预设」比，不能和「主题默认值」比**（`useMetricColorsEditor`
  的 `commit`）：暗色深度 `darkDepth` 早先用 `!== DEFAULT_DARK_DEPTH`（默认 0=灰黑）判定是否写
  localStorage —— 站点预设是 60（深黑）时，用户选「灰黑」(=0=默认) 会被当成「和默认相同、无需
  覆盖」而删键，值又被站点预设的 60 盖回去，表现为**「灰黑点不上、一点就弹回深黑」**（2026-08-26
  栽过）。改成和 `siteDarkDepthRef`（后端 theme_options 里的 darkDepth）比：只要不同就落本机覆盖。
  `resetAll`（「全部重置」）同理归到站点值而非默认值，才能真正「跟随站点」；「全部重置」的可点
  判定用 `hasLocalOverrides`（本机真存过 `metricColors`/`darkDepth` 键）而非「当前值≠默认」，
  否则跟随非默认站点预设时会常亮。配色 `metricColors` 的 per-key 恢复仍是「删本机键→跟随站点色」，
  没做「存主题默认色压站点色」，暂按现状（没人反馈）。
- **后台改「主题自定义配置」不是立刻生效，先等两分钟再判**：后端 `loadAppearanceOptions` 有
  2 分钟内存缓存（`src/utils/settings.js` 的 `SITE_SETTINGS_TTL`，读的是 huilang-me/CF-Server-Monitor），
  保存时会清缓存，但每个 Worker isolate 各存一份，换台设备打开照样可能拿到旧的。
  2026-08-21 栽过一次：站长粘了新键、新浏览器打开还是旧行为，等一会儿自己就好了。
  收到「后台设的某项不生效」，按顺序查两件事，别先动主题的合并逻辑 ——
  ① `fetch('/api/config').then(r=>r.json()).then(c=>console.log(c.theme_options))` 看后端到底下发了什么；
  ② `fetch(document.querySelector('script[type=module]').src).then(r=>r.text()).then(t=>console.log(t.includes('那个键')))`
  看**当前跑的产物认不认这个键** —— Workers 对分支地址缓存约 1 小时，很可能还是上一版产物，
  新加的设置键在旧包里根本不存在（实测 `dist-preview` 的 `2c955a8` 里 0 次、`0b66991` 里 4 次）。
- **首页卡片和详情页图表的丢包率对不上是正常的，别去「修」**：分辨率差着一个数量级 ——
  首页窗口一行约 6 分钟（2 小时 20 行，2026-08-24 起；此前是 1 小时 20 行、一行 3 分钟），
  详情页历史约 30 秒一行。短促的丢包在窗口里要么整段
  没被采到、要么被一整格放大。两边各自算的都没错，首页又不能查历史（见硬约束），只能认。
  （旧后端时期差得更离谱：窗口 1.07% 对历史 5.52%，那是复印段造成的，见下面那条。）
- **掉线段靠 `offlineSince` 截断，不能只看「有没有样本」**：`buildPingBuckets` 拿节点的
  `updatedAt` 当分界，丢掉晚于它的样本 —— 后端窗口在节点掉线后很可能照样按墙钟铺格子、
  沿用最后一个已知值，不挡掉就会把掉线段填满。整格都在分界之后才标 `offline` 涂红，
  当前那格要被掉线时间填满才翻红（红格于是一格一格往左推）。
- **`/api/servers` 是缓存快照，它的瞬时速率系统性偏高，首屏尤其要挡**：`net_in_speed` /
  `net_out_speed` 是被冻住的**某一个** 2 秒均值样本。2026-08-22 实测 8 台：`last_updated`
  落后 29~78 秒，速率字段**无一例外**高于其后 28 秒的 WS 均值（单台 1.35~10 倍，合计
  1.0 MB/s 对 0.28 MB/s），而累计计数器两边一致 —— 只有速率陈旧。
  两道防线缺一不可：① `performServersSync` 在快照不比现值新时只取 WS 不下发的字段
  （在线状态、月度累计）；② `shouldTrustSnapshotRate` —— 快照超过 10 秒就不认它的速率，
  沿用现值等第一帧 WS。只有 ① 挡不住首屏：那时没有现值可比，虚高值长驱直入
  （站长反馈的「刚打开/刷新完页面流量暴涨」就是它）。
  **WS 确定连不上时（`realtimeKnownUnavailable`）仍然采用快照速率** —— 轮询兜底时它是
  唯一数据源。累计流量、在线状态不受这条影响，那些字段不随时间衰减。
- **WSS 是逐台的实时流，不是「一批打包多个采样点」**：每条 `batchUpdate` 一台节点、一个样本、
  各带真实 ts，活跃节点约 2 秒一条；慢节点偶尔一次补发几帧（ts 相隔十几秒却同时到达）。
  节奏要按**实际到达时间**测，用样本 ts 会被补发帧带偏、越积越多（栽过一次）。
- **实时刷新的节奏必须按「每台节点自己的出帧速率」算**（`resolveWsNodeIntervalMs`）：各节点
  上报快慢不一（实测有节点是别人的两倍），且有的会一次上报多帧。口径是「该节点平均多久到一帧」
  —— 2 秒来 2 帧就恒定 1 秒一帧。三条踩过的坑：① 全局统一节拍会把快节点压慢、或让它攒队列而
  恒滞后一拍；② 按「当前队列深度」临时换算会走成 1000→2000→1000→667 的循环（放空后干等一个
  到达间隔）；③ 滑动窗口的分母要取「第一帧之后到达的帧数」，用 `length-1` 在成簇到达时会把间隔
  算小、放帧快于到达而积压。顶部「实时带宽」是跨节点求和，另按 1 秒节拍单独节流
  （`usePacedRate`），否则各节点相位不同会让它一秒变好几次。
  **积压超过 4 秒就跳到最新一帧**（`resolvePlaybackDropCount`）：标签页被后台节流后队列会
  攒满，逐帧匀速放意味着把十几秒前的旧尖峰当「实时」再播一遍。判据用「按当前节奏还要放多久」
  而不是「积压几帧」，出帧间隔本来就大的慢节点才不会被误判成落后；1~2 帧的正常积压照旧匀速。
- **后端探测窗口 2026-08-23 换了实现，老的那套坑基本作废**（站长口径：改成从 D1 取窗口的
  ping/loss，返回条数由 30 条改为 20 条）。2026-08-23 实测 8 台佐证：每台 20 行、步长
  179~180 秒、跨度 56.7~56.9 分钟，**各行数值都在变，没有复印段**。
  **2026-08-24 站长又把窗口跨度从 1 小时拉到 2 小时**（还是 20 个点，步长≈6 分钟；D1 消耗略大、
  换成 5 分钟服务端缓存压回来），并要求「前端不写死时间区，自动取 api 返回的内容」——
  v1.2.11 起前端柱子的跨度直接取「最老一个采样点到 now」，不再写死小时数（见 `buildPingBuckets`
  的 `resolvePingWindowMs`）。步长/跨度这些黑盒实测数是当时那一版的，后端再调会变，别当常量。
  - 旧实现（2026-08-18 读 `huilang-me/CF-Server-Monitor` 源码定位）是 `MetricsBroadcaster.js`
    的 `buildFixedLatencySeries` 固定吐 30 格、每格取**没有距离上限**的最近邻，于是桶里只有
    1 个真样本时另外 29 格全是复印件；桶还只在有前端 WS 订阅时才攒。**这套现在不复现了**，
    留着只为解释历史截图和 `dropBackfilledRuns` 为什么存在。
  - `dropBackfilledRuns`（连续 ≥4 格四条线路延迟与丢包逐字节相同就整段丢掉）**留着不动**：
    对新后端基本不触发，对还没升级的站点仍是保护。门槛别调低。
    副作用照旧：延迟恒定不变的节点（探测目标在本机、常年 1ms）会被整段丢掉。
  - 没有读过新后端源码，**「后端现在怎么实现的」是 pending**；只有上面那组黑盒实测是确定的。
- **首页延迟条：本地实测优先，窗口只补没覆盖到的时段**（v1.2.7，`mergeWindowWithLocal`）：
  一度反过来做过（窗口权威、本地只补缺口），就是上面那组数据把它证伪的。判定「实测覆盖到了」
  的口径是**前后都有本地样本且中间没断**（间隔不超过 `max(step, cadence*2)`）。窗口里
  「格子在、值是 null」的槽位附近只要有实测点就让它顶上 —— 图表对明确没值的槽位是真的留空的，
  不顶就平白空一格。缓冲区超上限时按时间抽稀，**不能 `slice(-N)`**：那会整段砍掉最老的，
  而最老的半段往往正是窗口独有、本地没覆盖的部分，砍掉柱子就左半段空。
  详情页查回来的历史会回灌这个缓冲（`api.ts` 的 `backfillPingBuffer` → `seedMeasuredHistory`，
  挂在 `fetchHistoryRows` 回调上，不额外发请求），所以**「点开过详情页的节点数据更准」是预期
  行为**，不是 bug。
- **采样与计权：一次探测记一个样本，每个样本按它代表的时长计权**（`recordPingSample` /
  `assignWeights`）。这两处各栽过一次，合起来把丢包率抬高过一半：
  - 采样：探针 60 秒才测一次、WS 每 2 秒把同一结果重推一遍，所以「值变了」等价于「新探测落地」，
    一到就记；值没变每 2 分钟留一个心跳（只为柱子有点可画）。早先「值没变 50 秒、值变了 20 秒」
    的不对称阈值会在每次丢包的**切换处**多记一个样本，丢包样本被系统性多记。
  - 计权：丢包率按样本条数加权，而窗口 2 分钟一个点、本地疏密不定 —— 按条数算，密的那段说话
    大好几倍，比例还随页面开着的时长漂移（早先「首页数据不对」的根）。时长必须按**「到下一次
    采样为止」**算（和 `buildPingBuckets` 铺格子一致），按「前后邻居的中点」算会在疏密不均处
    翻车：一个只代表 60 秒的丢包样本拿到 90 秒权重，丢包率凭空高一半。基数 `WEIGHT_SCALE = 8`。
  - 连带：`resolvePingSampleCounts` 会把权重取整并至少算 1 份，别指望小数权重；`sameSeries`
    必须一起比 `weight`，否则「样本没变、只有权重变了」被判成没变，加权结果被旧缓存顶掉。
  - 改这两处后跑准确度回归（`pingLiveStore.test.ts` 的「采样与计权的准确度」）：构造 60 次探测
    含 8 次丢包的推送流，算出的丢包率与按时间的真值偏差要小于 15%。这类 bug 单测全绿也发现不了。
- **卡片上那个「当前延迟」数字不走窗口**，由 `withLiveLatency` 换成 WS 实时值；丢包率不能这么办
  —— 它是整段窗口的加权平均，取最后一次采样会把「6 个包丢 1 个」顶成 16% 而柱子还是全绿。
- **`/api/servers` 有服务端缓存（站长口径 30 秒）**：实测同一份字节至少冻结 24 秒，加随机 query
  参数也绕不过（缓存在 Worker 里不是 CDN —— 响应头没有 `cache-control` / `age` /
  `cf-cache-status`）。全量刷新因此定在 60 秒（v1.2.7，原来 30 秒）；「快照比 WS 旧十几到
  几十秒」的根因也是它。
- **历史接口的点数是后台设的，区间越长分辨率越粗**：`long_history_points`（60/120/180/240）
  是「查询超过 1 小时时返回的采样点数」，点数固定而区间不固定，于是 240 点时 1 天约 6 分钟
  一个 —— 持续一两分钟的丢包在长区间可能整段没被采到（同一次丢包 1 小时图可见、1 天图消失）。
  另：未登录访客查超过 24 小时会返回 **401**，`Instance.tsx` 已按登录态把档位卡住，别误判成
  「后端没数据」。
- **柱子的数值在触屏上靠「点选」，不是 hover**（v1.2.9）：`supportsFineHover()` 在触屏恒为 false，
  所以手机上那排延迟/丢包格子原来点了没反应。三种渲染层各自实现（canvas 的 `CanvasStrip`、
  紧凑卡的 DOM、迷你卡的 SVG），共用 `touchBucketPick.ts` 的两条口径：命中按**整条宽度均分**
  （一根柱子连间距才 4~5px，按柱子自己的范围算点不中），气泡在抬手后再留 2.5 秒（触屏没有
  「移开鼠标」，不自动收就一直挂着）。三处配套细节别拆掉：① `compact-node-card.css` 里
  `@media (any-hover: none)` 那块 `content-box` + `padding-block` + 等量负 margin 是**命中区**，
  纵向撑开而占位不变，横向一动命中换算就偏；② `CanvasStrip` 在触屏点选后会 `preventDefault` 掉
  那一次 click —— 列表视图整行是 `<Link>`，不挡就变成「想看数值结果跳走了」；③ 手指按着才跟随
  （`event.buttons`/pointer 捕获），触屏没有悬停，无条件跟随会把刚点的那格立刻抹掉。
  验证时注意：浏览器面板隐藏时自动化点击只发得出 pointerdown，抬手事件根本没派发，
  「气泡不收」是工具的假象，不是 bug（要用合成事件补 pointerup 才测得准）。
- **柱子格数只有一个来源，CSS 不许再写一遍**：四种视图统一读
  `HOMEPAGE_PING_BUCKET_COUNT`（v1.2.10 起 = 20，对齐后端 20 行；v1.2.11 后窗口跨度拉到 2 小时，
  一格从 3 分钟变约 6 分钟，**格数没变**）。2026-08-23 栽过：JS 从 18 改成 20，
  `compact-node-card.css` 里还写死着 `grid-template-columns: repeat(18, ...)`，多出来两根直接
  掉到第二排。现在那里是 `grid-auto-flow: column` + `grid-auto-columns`，列数由柱子数量自己撑开。
- **柱子的时间跨度不写死、跟着数据走**（v1.2.11，`buildPingBuckets` 的 `resolvePingWindowMs`）：
  取「最老一个采样点到 now」，夹在 30 分钟（下限，防刚加进来的节点被画成几格宽）到
  `SAMPLE_TTL_MS`（上限）之间。后端把窗口从 1 小时改到 2 小时、或以后再调，前端都不用动 ——
  这是站长要的「前端自动取 api 返回的内容」。连带 `MAX_SAMPLE_HOLD_MS` 的上限也改成跟着格宽走
  （`holdCapMs = max(它, bucketMs*2)`）：一格 6 分钟时死守 5 分钟会短于后端相邻两点的间距，
  把连续的点断成一条条缝（栽过，就是这个）。
  **后端还会在 `/api/config` 下发 `latency_window`**（`{points,hours}`，v1.2.11 起认）：有它就
  用 `hours` 当 `windowMs` 显式钉住跨度（`useLatencyWindowMs` → `useNodeCardModel` → `buildPingBuckets`
  的第 5 个参数），比从数据推更稳；缺席（老后端 / 还没上线）回退到上面那套自推。`points` 暂不驱动
  格数（格数仍固定 `HOMEPAGE_PING_BUCKET_COUNT`）。注意 `hours*3600000` 仍会被上面那对上下限夹住 ——
  `hours` 超过 `SAMPLE_TTL_MS` 对应的小时数时会被 TTL 截住（要真放到更长得同时抬 TTL）。
  `latency_window` 在 `SiteConfigSchema`（`/api/config`），不是 `SysConfigSchema`（`/api/servers`）。
- **后端可以关掉首页的详细 ping/loss**（`sysConfig.show_three_net_details`，后端 2026-08-23
  新增）：关掉时 `servers[].ping[]` / `loss[]` 那份窗口不再下发，只剩每台当前的单条
  `ping_ct/cu/cm/bd`。主题据此把三网三条线回退到单线路（否则三条空线）。
  （v1.2.11 之前还会据它决定「开页自检跑不跑」，自检删掉后这条不用管了。）
  **默认必须是 true**：老后端不下发这个字段而它们一直输出详细数据，默认 false 会让存量站点
  的三网线全部消失。
- **缓冲区保留期 v1.2.11 放宽到 2 小时 + 15 分钟余量**（`SAMPLE_TTL_MS = PING_WINDOW_MS + 15min`）：
  后端 20 行跨约 2 小时、最新一行本身还能旧到几分钟（5 分钟服务端缓存），最老那行到主题手里常常
  已经接近满窗跨度，留太紧会把本来有真数据的最老一格丢掉。1 小时时代 TTL 正好 60 分钟是擦边状态，
  7/8 台的最老行一进来就过期、靠 `leadingHoldMs` 向前回填勉强盖住；现在给足了余量不再擦边。
  副作用是卡片丢包率的平均窗口跟着变宽（整段缓冲区的加权平均），而这正是后端把窗口拉到 2 小时
  想要的口径。再收到「第一格空」先量 `最老行年龄 = 窗口跨度 + 最新一行年龄`，超过 TTL 就是它。
- **标签分隔符两种都要认**（`parseTags`）：后台输入框的提示是「英文逗号割开」，而移植自 Komari
  的代码原本只切分号 —— 从 Komari 迁过来的站点数据里是分号，本后端按提示填的是逗号，两种数据
  同时存在。全角 `，；` 也认（中文输入法误打），标签名里本来就不该有分隔符。

## 当前状态

**v1.2.12 已发布**（2026-08-26），`dist` 头是产物提交 `53ae093`（主 chunk `index-BVsBraqp.js`；
与 preview 上验收的 `9bb03db` 同一份产物）。适配后端 2.1.1 的 `POST /api/theme_options`，三件事：
① 设置页给登录站长加「保存到后端」按钮（`cfsmPost` / `saveThemeOptions` / `handleSaveToSite`），
无需再复制 JSON 手动粘到后台；工具栏统一「本机 / 后端」两套词、登录站长隐藏「复制配置 JSON」，
两个「保存到X」并排、发布到后端是最右主按钮。② 配色自定义浮层也加「保存到后端」
（`useMetricColorsEditor.saveToBackend` / `MetricColorPicker`），并在登录站长那行省掉「配色自定义」
标题腾地方。③ 修「灰黑」在站点预设非默认时点不上（`commit` 改和 `siteDarkDepthRef` 比、
`resetAll` 归站点值、`hasLocalOverrides`；详见「容易踩的坑」那条）。439 项测试通过。
**Turnstile 403 重试路径只有单测覆盖**，真机得站长登录后点一次「保存到后端」才触发（发版前未逐帧核过）。

**v1.2.11 已发布**（2026-08-24），`dist` 头是产物提交 `be9d06c`（主 chunk `index-DG-N805B.js`；
与 preview 上验收的 `840f763` 同一份产物）。这一版四件事：
① 适配后端把首页 ping/loss 窗口从 1 小时改成 2 小时（还是 20 点）—— 柱子跨度改成**自动跟着数据走**
（`buildPingBuckets` 的 `resolvePingWindowMs`，取「最老一点到 now」），后端再调窗口前端不用动；
② 样本保留期跟着放宽到 2 小时 +15 分钟（`SAMPLE_TTL_MS`）；③ 去掉开页自检弹窗及其设置开关
（`usePingDataHealthPrompt` / `pingWindowHealth` / `enablePingHealthPrompt` 全删）；
④ 认后端 `/api/config` 的 `latency_window{points,hours}`——有就用 `hours` 显式钉跨度、缺席回退自推，
`points` 暂不驱动格数（`useLatencyWindowMs`；细节见「容易踩的坑」那条）。436 项测试通过。
**注意**：`latency_window` 发这版时后端**还没上线**，只在 mockApi 里造了数据自测，真机得等后端
下发才验得到（缺席会走回退，不会坏）。

v1.2.10 已发布（2026-08-23），`dist` 头是产物提交 `1c6fa1a`（主 chunk `index-Cp-rdXIv.js`）。这一版四件事：
① 四种视图的延迟/丢包柱子统一 20 格（`HOMEPAGE_PING_BUCKET_COUNT`），对齐后端新版的
20 行；② 首页「实时带宽」不再在刚打开/刷新页面时虚高、也不再一秒内跳好几次，切回标签页
不再回放旧尖峰；③ 适配后端的 `sysConfig.show_three_net_details`；④ 每页底部加了
`Powered by CF-Server-Monitor · Theme by LuminaPlus` 两个 GitHub 链接。

v1.2.9（2026-08-21）在 `dist` 上有**两条同名提交**：`4b0192e` 是半成品、`40843e5` 才是完整版
（成因与预防见「发布流程」）。主题商店里的版本登记由站长自己更新，代码这边推完 `main` 就算完。

**「流量有问题」这类反馈先按这里的实测数据判，别直接改代码**（2026-08-22 在站长面板上量的）：
主题自身的流量约 **2.6 KB/s**（WS 载荷 2.5 KB/s + `/api/servers` 每 60 秒一次），刷新页面
命中缓存只有 6 KB，和内置主题一个量级；后端下发的 `net_in_speed` 逐帧核对与 `Δnet_rx ÷ Δts`
完全吻合，是准的；顶部求和的算法与内置主题一致（在线节点速率直接相加、都不做平滑）。
所以**节点真有爆发流量时数字跳到 MB 级是照实画的**，不是 bug —— 该站有两台节点常年
80~140 KB/s 双向、还带 2 秒 590 KB/s 的爆发，把面板整个关掉 2.5 分钟用累计计数器差分复核，
量级一样，与面板开不开无关。

真机验收（2026-08-24 站长确认全过）：v1.2.9 的触屏点柱子看数值、v1.2.4 的 Ping 图表辅助线
触屏拖动、v1.2.10 的列表视图柱宽（12→20 根后约 4px）—— 三项都 OK，不再是 pending。

待后端 / 待确认：
1. 新版后端**没有读过源码**，只有黑盒实测（见「容易踩的坑」那条）。旧版那三个问题
   （最近邻无距离上限、每格存最后一次上报而非聚合、无 WS 订阅就不攒桶）现象上不再复现，
   但没有源码佐证「已修」。
2. CI 没有「同版本号重复发布」的守卫，已向用户提过，等决定。
3. `latency_window` 前端已就绪（v1.2.11），2026-08-26 复核**后端已在线上下发**
   （`monitor.8881025.xyz` 的 `/api/config` 返回 `{hours:2,points:20}`），「按 hours 钉跨度」
   这条路现在真机可验，不再是 pending。

v1.2.5 遗留：`src/pages/Traffic.tsx`、`useTodayTrafficStats`、`utils/trafficStats.ts` 与
`components/traffic/` 已无人引用（`#/traffic` 路由与首页入口都摘掉了，2026-08-23 复核仍是
唯一引用者就是它们自己和各自的测试），刻意留着以便日后恢复；真要删就连 `traffic-stats.css` 与两个测试一起清。
