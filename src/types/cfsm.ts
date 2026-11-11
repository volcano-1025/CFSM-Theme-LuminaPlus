import * as z from "zod/mini";

/**
 * 上半部分是 CF-Server-Monitor 后端的原始响应结构（宽松解析，容忍字段缺失/类型漂移），
 * 下半部分是主题内部的展示模型。两者之间由 `@/services/cfsm/mappers` 转换。
 */

/*
 * 用的是 zod 的精简版（zod/mini）：规则写成函数嵌套而不是链式调用，没用到的校验器不会进产物
 * （标准版 zod 4 约 25 KB gzip，全在首屏）。对照表：
 *   x.default(v)   → withDefault(x, v)     x.optional() → z.optional(x)
 *   x.catch(v)     → z.catch(x, v)         x.transform(f) → z.pipe(x, z.transform(f))
 *   .passthrough() → z.looseObject({...})
 */
const withDefault = z._default;

const looseString = z.catch(
  z.pipe(
    z.union([z.string(), z.number(), z.boolean()]),
    z.transform((v) => String(v)),
  ),
  "",
);
const looseNumber = z.catch(
  z.pipe(
    z.union([z.number(), z.string()]),
    z.transform((v) => {
      if (typeof v === "number") return Number.isFinite(v) ? v : 0;
      const parsed = Number.parseFloat(v);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
  ),
  0,
);
const nullableNumber = z.catch(
  z.nullish(
    z.pipe(
      z.union([z.number(), z.string(), z.null()]),
      z.transform((v) => {
        if (v == null) return null;
        if (typeof v === "number") return Number.isFinite(v) ? v : null;
        const parsed = Number.parseFloat(v);
        return Number.isFinite(parsed) ? parsed : null;
      }),
    ),
  ),
  null,
);
/** 缺席 / null 读成空串的字符串（后端后加的字段，老后端不下发）。 */
const blankableString = z.pipe(
  z.nullish(looseString),
  z.transform((v) => v ?? ""),
);
/** 字符串或数字的 ID，统一成字符串；别的类型算校验失败。 */
const idString = z.pipe(
  z.union([z.string(), z.number()]),
  z.transform((v) => String(v)),
);
/** 磁盘 IO；旧探针或全零时后端不会下发该对象。 */
export const DiskIoSchema = z.looseObject({
  read_bps: withDefault(looseNumber, 0),
  write_bps: withDefault(looseNumber, 0),
  read_iops: withDefault(looseNumber, 0),
  write_iops: withDefault(looseNumber, 0),
  await_ms: withDefault(looseNumber, 0),
  util: withDefault(looseNumber, 0),
});

export type DiskIo = z.output<typeof DiskIoSchema>;

export const GpuEntrySchema = z.looseObject({
  id: withDefault(looseString, ""),
  name: withDefault(looseString, ""),
  info: nullableNumber,
});

export type GpuEntry = z.output<typeof GpuEntrySchema>;

/**
 * `/api/servers` 下发的一小时探测窗口中的一个点。
 *
 * 固定 30 个槽位、每 2 分钟一个，`ping` 与 `loss` 各一个数组。
 * 线路值可能是 `false`（该节点禁用了这条线路），这里统一归一成 null。
 */
export const LatencyPointSchema = z.looseObject({
  ts: withDefault(looseNumber, 0),
  ct: nullableNumber,
  cu: nullableNumber,
  cm: nullableNumber,
  bd: nullableNumber,
  // 后端 2.8.5 Beta4 起多出来的四个自定义槽位。老后端不下发，读出来是 undefined → null。
  node_1: nullableNumber,
  node_2: nullableNumber,
  node_3: nullableNumber,
  node_4: nullableNumber,
});

/**
 * `/api/servers` 与 `/api/server` 的服务器对象。
 *
 * 单位约定（与后端一致）：`ram_*` / `swap_*` / `disk_*` 为 MiB，网络速率与累计量为字节，
 * `traffic_limit` 为 GB，`boot_time` / `last_updated` 为毫秒时间戳。
 */
export const CfsmServerSchema = z.looseObject({
  id: idString,
  name: withDefault(looseString, ""),
  server_group: withDefault(looseString, ""),
  tags: withDefault(looseString, ""),
  price: withDefault(looseString, ""),
  billing_cycle: withDefault(looseString, ""),
  auto_renewal: withDefault(looseString, ""),
  currency: withDefault(looseString, ""),
  expire_date: withDefault(looseString, ""),
  traffic_limit: withDefault(looseString, ""),
  traffic_calc_type: withDefault(looseString, ""),
  reset_day: withDefault(looseNumber, 0),
  report_interval: withDefault(looseNumber, 0),
  is_hidden: withDefault(looseString, "0"),
  sort_order: withDefault(looseNumber, 0),

  cpu: withDefault(looseNumber, 0),
  load_avg: withDefault(looseString, ""),
  net_in_speed: withDefault(looseNumber, 0),
  net_out_speed: withDefault(looseNumber, 0),
  net_rx: withDefault(looseNumber, 0),
  net_tx: withDefault(looseNumber, 0),
  net_rx_monthly: withDefault(looseNumber, 0),
  net_tx_monthly: withDefault(looseNumber, 0),
  processes: withDefault(looseNumber, 0),
  tcp_conn: withDefault(looseNumber, 0),
  udp_conn: withDefault(looseNumber, 0),

  ping_ct: nullableNumber,
  ping_cu: nullableNumber,
  ping_cm: nullableNumber,
  ping_bd: nullableNumber,
  ping_node_1: nullableNumber,
  ping_node_2: nullableNumber,
  ping_node_3: nullableNumber,
  ping_node_4: nullableNumber,
  loss_ct: nullableNumber,
  loss_cu: nullableNumber,
  loss_cm: nullableNumber,
  loss_bd: nullableNumber,
  loss_node_1: nullableNumber,
  loss_node_2: nullableNumber,
  loss_node_3: nullableNumber,
  loss_node_4: nullableNumber,
  // Workers 2.8.3 Beta2 起下发的一小时探测窗口；旧版本没有这两个字段。
  ping: z.optional(z.array(LatencyPointSchema)),
  loss: z.optional(z.array(LatencyPointSchema)),

  ram_total: withDefault(looseNumber, 0),
  ram_used: withDefault(looseNumber, 0),
  swap_total: withDefault(looseNumber, 0),
  swap_used: withDefault(looseNumber, 0),
  disk_total: withDefault(looseNumber, 0),
  disk_used: withDefault(looseNumber, 0),
  disk: z.optional(DiskIoSchema),

  cpu_cores: withDefault(looseNumber, 0),
  cpu_info: withDefault(looseString, ""),
  gpu_info: z.optional(z.unknown()),
  arch: withDefault(looseString, ""),
  os: withDefault(looseString, ""),
  kernel_version: withDefault(looseString, ""),
  region: withDefault(looseString, ""),
  ip_v4: withDefault(looseString, "0"),
  ip_v6: withDefault(looseString, "0"),
  boot_time: withDefault(looseString, ""),
  agent_version: withDefault(looseString, ""),
  last_updated: withDefault(looseNumber, 0),
  timestamp: withDefault(looseNumber, 0),
  /**
   * 后端收到这台最近一次上报的时刻（后端自己的时钟）。不是后端字段：主题从 `latestReportUpdates[].reportTs` 和
   * WS 消息的 `ts` 填进来，判在线用它（见 mappers 的 `isServerOnline`）。`last_updated` 是探针时钟打的样本时间。
   */
  report_timestamp: z.optional(looseNumber),
  is_online: z.optional(z.boolean()),
});

export type CfsmServer = z.output<typeof CfsmServerSchema>;

export const LatestReportUpdateSchema = z.looseObject({
  serverId: idString,
  reportTs: z.optional(looseNumber),
  reportAgeMs: z.optional(looseNumber),
  samples: withDefault(
    z.array(
      z.looseObject({
        ts: z.optional(looseNumber),
        data: z.optional(z.record(z.string(), z.unknown())),
        payload: z.optional(z.record(z.string(), z.unknown())),
        metrics: z.optional(z.record(z.string(), z.unknown())),
      }),
    ),
    [],
  ),
});

export type LatestReportUpdate = z.output<typeof LatestReportUpdateSchema>;

export const SysConfigSchema = z.looseObject({
  show_price: withDefault(z.boolean(), true),
  show_expire: withDefault(z.boolean(), true),
  show_tf: withDefault(z.boolean(), true),
  show_time: withDefault(z.boolean(), true),
  /**
   * 后端是否输出首页的**详细** ping/loss（`servers[].ping[]` / `loss[]` 那一小时窗口）。
   *
   * 后端 2026-08-23 加的开关。关掉时那两个数组不再下发，只剩每台节点当前的
   * `ping_ct/cu/cm/bd` 单条值 —— 主题要据此回退，不然三网那三条线没有数据可画、
   * 开页自检也会把「本来就不下发」误判成「后端数据坏了」而反复弹窗。
   * 默认 true：老版本后端没有这个字段，而它们是一直输出详细数据的。
   */
  show_three_net_details: withDefault(z.boolean(), true),
  long_history_points: z.optional(looseNumber),
  display_mode: z.optional(looseString),
});

export type SysConfig = z.output<typeof SysConfigSchema>;

export const ServersResponseSchema = z.looseObject({
  servers: withDefault(z.array(CfsmServerSchema), []),
  latestReportUpdates: withDefault(z.array(LatestReportUpdateSchema), []),
  // 各项都可缺：缺了就是 undefined，不补 0（调用方按「后端没给」处理）。
  stats: withDefault(
    z.looseObject({
      total: z.optional(looseNumber),
      online: z.optional(looseNumber),
      offline: z.optional(looseNumber),
      globalSpeedIn: z.optional(looseNumber),
      globalSpeedOut: z.optional(looseNumber),
      globalNetTx: z.optional(looseNumber),
      globalNetRx: z.optional(looseNumber),
    }),
    {},
  ),
  regionStats: withDefault(z.record(z.string(), looseNumber), {}),
  // prefault：缺省时拿 {} 再过一遍这份规则，里面各字段的默认值才会补上。
  // zod 4 的 default 是直接返回给的值、不再解析（v3 会解析），用它会得到一个空对象。
  sysConfig: z.prefault(SysConfigSchema, {}),
});

export const SiteConfigSchema = z.looseObject({
  version: withDefault(looseString, ""),
  last_workers_version: blankableString,
  last_agent_version: blankableString,
  is_public: withDefault(z.boolean(), true),
  authorization: withDefault(z.boolean(), false),
  turnstile_enabled: withDefault(z.boolean(), false),
  turnstile_login_enabled: withDefault(z.boolean(), false),
  turnstile_site_key: withDefault(looseString, ""),
  site_title: withDefault(looseString, ""),
  display_mode: withDefault(looseString, ""),
  /** 后台「外观设置 → 默认外观」：auto / dark / light。主题设置没写默认外观时拿它垫底。 */
  preferred_theme: withDefault(looseString, ""),
  /** 后台「外观设置 → 默认语言」：auto / zh / en / es。主题的界面语言跟着它走，见 i18n 的 `resolveLanguage`。 */
  default_language: withDefault(looseString, ""),
  theme_options: withDefault(z.record(z.string(), z.unknown()), {}),
  verified: withDefault(z.boolean(), false),
  turnstile_verified: blankableString,
  long_history_points: withDefault(looseNumber, 120),
  /**
   * 单次前端实时连接的时长上限（分钟，0 = 不限；后端 2026-08-20 加的站点设置）。后端只下发不执行：
   * 到点断开、问用户要不要继续都靠前端，见 wsStore 的 setRealtimeSessionLimitMinutes。
   */
  frontend_ws_timeout_minutes: withDefault(looseNumber, 0),
  /**
   * 站长在后台给四条线路起的名字（后端后加的字段）。缺席 / 空串就用主题的默认名
   * （电信 / 联通 / 移动 / BD），见 mappers 的 `resolveCarrierNames` —— 老后端不下发这几个
   * 字段，默认名必须原样保留，否则存量站点的线路名会集体变空。
   */
  custom_ct_name: blankableString,
  custom_cu_name: blankableString,
  custom_cm_name: blankableString,
  custom_bd_name: blankableString,
  // 后端 2.8.5 Beta4 起多出来的四条自定义线路，名字键名和前四条不是一个风格。
  node_1_name: blankableString,
  node_2_name: blankableString,
  node_3_name: blankableString,
  node_4_name: blankableString,
  /**
   * 后端下发的首页延迟窗口口径：`points`=柱子格数、`hours`=窗口跨度（小时）。
   * 后端后加的字段，老后端 / 还没上线时缺席 —— 前端据 `hours` 定跨度，缺席就回退到
   * 「从数据时间戳自推」（见 usePingOverview 的 buildPingBuckets）。`points` 暂不驱动格数。
   */
  latency_window: z.optional(
    z.looseObject({
      points: z.optional(looseNumber),
      hours: z.optional(looseNumber),
    }),
  ),
});

/** `/api/history/all` 的一行；字段随后端列定义，缺失时按 0 处理。 */
export const HistoryRowSchema = z.looseObject({
  timestamp: withDefault(looseNumber, 0),
  cpu: withDefault(looseNumber, 0),
  gpu_info: z.optional(z.unknown()),
  ram_total: withDefault(looseNumber, 0),
  ram_used: withDefault(looseNumber, 0),
  swap_total: withDefault(looseNumber, 0),
  swap_used: withDefault(looseNumber, 0),
  disk_total: withDefault(looseNumber, 0),
  disk_used: withDefault(looseNumber, 0),
  disk: z.optional(DiskIoSchema),
  disk_read_bps: z.optional(looseNumber),
  disk_write_bps: z.optional(looseNumber),
  disk_read_iops: z.optional(looseNumber),
  disk_write_iops: z.optional(looseNumber),
  disk_await_ms: z.optional(looseNumber),
  disk_util: z.optional(looseNumber),
  processes: withDefault(looseNumber, 0),
  net_in_speed: withDefault(looseNumber, 0),
  net_out_speed: withDefault(looseNumber, 0),
  tcp_conn: withDefault(looseNumber, 0),
  udp_conn: withDefault(looseNumber, 0),
  ping_ct: nullableNumber,
  ping_cu: nullableNumber,
  ping_cm: nullableNumber,
  ping_bd: nullableNumber,
  ping_node_1: nullableNumber,
  ping_node_2: nullableNumber,
  ping_node_3: nullableNumber,
  ping_node_4: nullableNumber,
  loss_ct: nullableNumber,
  loss_cu: nullableNumber,
  loss_cm: nullableNumber,
  loss_bd: nullableNumber,
  loss_node_1: nullableNumber,
  loss_node_2: nullableNumber,
  loss_node_3: nullableNumber,
  loss_node_4: nullableNumber,
  load_avg: withDefault(looseString, ""),
  kernel_version: withDefault(looseString, ""),
});

export type HistoryRow = z.output<typeof HistoryRowSchema>;

/* ------------------------------------------------------------------ *
 * 展示模型
 * ------------------------------------------------------------------ */

/** 节点静态信息。字节口径已在 mapper 中统一换算，UI 层不再关心后端单位。 */
export interface NodeInfo {
  uuid: string;
  name: string;
  group: string;
  region: string;
  hidden: boolean;
  cpu_name: string;
  cpu_cores: number;
  arch: string;
  os: string;
  kernel_version: string;
  gpu_name: string;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  weight: number;
  price: number;
  billing_cycle: string;
  auto_renewal: boolean;
  currency: string;
  expired_at: string;
  tags: string;
  public_remark: string;
  /** 流量配额，字节；0 表示不限。 */
  traffic_limit: number;
  /** 归一化后的配额口径：sum / up / down / max。 */
  traffic_limit_type: string;
  /** 每月流量重置日（1–31），0 表示未设置。 */
  traffic_reset_day: number;
  /** 探针上报间隔，秒。 */
  report_interval: number;
  agent_version: string;
  /** CF-Server-Monitor 只下发可达性，不下发具体地址。 */
  ipv4: string;
  ipv6: string;
  created_at: string;
  updated_at: string;
}

/** 节点实时指标。所有容量字段为字节，速率为字节/秒。 */
export interface NodeMetrics {
  online: boolean | null;
  cpuPct: number;
  ramUsed: number;
  ramTotal: number;
  ramPct: number;
  swapUsed: number;
  swapTotal: number;
  diskUsed: number;
  diskTotal: number;
  diskPct: number;
  netUp: number;
  netDown: number;
  /** 累计上/下行（探针生命周期）。 */
  trafficUp: number;
  trafficDown: number;
  /** 本计费周期内的上/下行，配额进度以此为准。 */
  trafficUpMonthly: number;
  trafficDownMonthly: number;
  uptime: number;
  load1: number;
  load5: number;
  load15: number;
  process: number;
  connectionsTcp: number;
  connectionsUdp: number;
  gpuPct: number;
  gpuName: string;
  diskIo: DiskIo | null;
  /** 各线路实时延迟/丢包（见 CARRIER_KEYS），缺测为 null。 */
  ping: CarrierPingSnapshot;
  updatedAt: number;
}

/**
 * 后端探测线路的 key，**顺序即线路顺序**（对应 task id 1..N）。
 *
 * 后端 2.8.5 Beta4 起从四条加到八条：原来的电信/联通/移动/BGP 之外多了四个自定义槽位
 * （`/api/servers` 的 `ping_node_1..4`、窗口点里的 `node_1..4`、名字在 `/api/config` 的
 * `node_1_name..node_4_name`）。**以后再加线路只改这张表**——线路名、快照类型、窗口解析、
 * 紧凑存储、设置页的选项和上限全部由它推导（上限那条有 `pingTasks.test.ts` 的断言钉着）。
 */
export const CARRIER_KEYS = [
  "ct",
  "cu",
  "cm",
  "bd",
  "node_1",
  "node_2",
  "node_3",
  "node_4",
] as const;

export type CarrierKey = (typeof CARRIER_KEYS)[number];

/**
 * 快照里丢包字段的名字。原来四条是手写的 camelCase（`lossCt`…），新加的沿用同一风格；
 * 单独一张表而不是模板字面量，是为了不动既有字段名（改名会波及一大片消费端与测试）。
 */
export const CARRIER_LOSS_KEYS = {
  ct: "lossCt",
  cu: "lossCu",
  cm: "lossCm",
  bd: "lossBd",
  node_1: "lossNode1",
  node_2: "lossNode2",
  node_3: "lossNode3",
  node_4: "lossNode4",
} as const satisfies Record<CarrierKey, string>;

export type CarrierLossKey = (typeof CARRIER_LOSS_KEYS)[CarrierKey];

/**
 * 线路的显示名。id / key 由后端固定，只有名字可由站长改（`/api/config` 的
 * `custom_*_name` 与 `node_N_name`），默认名与归一化逻辑在 `services/cfsm/mappers` 的
 * `DEFAULT_CARRIER_NAMES` / `resolveCarrierNames`。
 */
export type CarrierNames = Record<CarrierKey, string>;

export type CarrierPingSnapshot = Record<CarrierKey, number | null> &
  Record<CarrierLossKey, number | null>;

export const EMPTY_CARRIER_PING: CarrierPingSnapshot = Object.freeze(
  Object.fromEntries([
    ...CARRIER_KEYS.map((key) => [key, null]),
    ...CARRIER_KEYS.map((key) => [CARRIER_LOSS_KEYS[key], null]),
  ]),
) as CarrierPingSnapshot;

export interface ThemeSettings {
  defaultAppearance?: "system" | "light" | "dark";
  desktopNodeViewMode?: "large" | "compact" | "mini" | "list";
  mobileNodeViewMode?: "large" | "compact" | "mini" | "list";
  enableAdminButton?: boolean;
  /** 首页快捷栏里显示哪些按钮（主题设置按钮一直显示，不然访客回不到设置页）。 */
  quickShowAppearance?: boolean;
  quickShowViewMode?: boolean;
  quickShowColors?: boolean;
  showPingChart?: boolean;
  homepagePingBindings?: Record<string, string[]>;
  homepageDefaultPingTaskId?: number;
  enableHomepageMultiPing?: boolean;
  homepageMultiPingTaskIds?: number[];
  /** 站长在卡片上换好、「保存到后端」写上来的逐节点换线：`{ uuid: { 行号: 线路 id } }`。 */
  homepagePingLineOverrides?: Record<string, Record<string, number>>;
  fakePingForUnbound?: boolean;
  showHomeOverview?: boolean;
  showGroupTabs?: boolean;
  showRegionBar?: boolean;
  showCardGroup?: boolean;
  homeGroupOrder?: string[];
  /** 首页地区栏的顺序（地区代码），在首页直接拖动得到；没列进去的按默认规则排在后面。 */
  homeRegionOrder?: string[];
  enableHomeSort?: boolean;
  homeSortField?: "default" | "name" | "speed" | "traffic" | "price";
  homeSortDirection?: "asc" | "desc";
  showCostSummary?: boolean;
  showCostSummaryFloatingButton?: boolean;
  showOverviewRatings?: boolean;
  showTrafficRating?: boolean;
  showBandwidthRating?: boolean;
  showAssetRating?: boolean;
  trafficRatingLabels?: string;
  bandwidthRatingLabels?: string;
  assetRatingLabels?: string;
  compactShowTrafficTotal?: boolean;
  compactShowBilling?: boolean;
  compactShowUptime?: boolean;
  showConnections?: boolean;
  hiddenNodes?: string[];
  costIgnoredNodes?: string[];
  // 值支持旧版纯数字(自动升格)或 { amount, paidCny?, acquiredAt? } 条目,见 normalizeCostPremiums。
  costPremiums?: Record<
    string,
    number | { amount?: number; paidCny?: number; acquiredAt?: string }
  >;
  costRateApiUrl?: string;
  surfaceOpacity?: number;
}

/** 图表用的一行历史负载记录，单位与 NodeMetrics 一致。 */
export interface LoadRecord {
  cpu: number;
  gpu: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  /** 1 分钟负载（后端历史存的是整串 load_avg）。 */
  load: number;
  load5: number;
  load15: number;
  temp: number;
  disk: number;
  disk_total: number;
  /** 磁盘 IO 速率（字节/秒）。旧探针/旧后端不下发时为 null —— 0 表示真的没有读写。 */
  disk_read: number | null;
  disk_write: number | null;
  net_in: number;
  net_out: number;
  /** CF-Server-Monitor 历史不保存累计流量，恒为 0。 */
  net_total_up: number;
  net_total_down: number;
  process: number;
  connections: number;
  connections_udp: number;
  time: number;
  client: string;
}

export interface LoadRecordsResponse {
  count: number;
  records: LoadRecord[];
  rangeStartMs?: number;
  rangeEndMs?: number;
  intervalSeconds?: number;
}

export interface PingRecord {
  task_id: number;
  time: number;
  value: number;
  client: string;
  count?: number;
  loss?: number | null;
}

export interface PingTask {
  id: number;
  interval: number;
  name: string;
  loss: number;
  clients: string[];
  type: string;
  target: string;
  weight: number;
}

export interface PingRecordsResponse {
  count: number;
  records: PingRecord[];
  tasks: PingTask[];
  intervalSeconds?: number;
  rangeStartMs?: number;
  rangeEndMs?: number;
  stats?: PingTaskStats[];
}

export interface PingTaskStats {
  client: string;
  taskId: number;
  name: string;
  type: string;
  interval: number;
  total: number;
  valid: number;
  loss: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  latest: number | null;
  p50: number | null;
  p99: number | null;
  stddev: number | null;
  p99P50Ratio: number;
}

export type PingOverviewTaskLoadState = "pending" | "ready" | "error";

export interface PingOverviewItem {
  client: string;
  isAssigned: boolean;
  /** 当前任务本轮请求状态；模拟 Ping 不设置此字段。 */
  loadState?: PingOverviewTaskLoadState;
  lastValue: number | null;
  /** 聚合桶的真实宽度。 */
  metricIntervalMs?: number;
  samples: Array<{
    time: number;
    value: number;
    count?: number;
    loss?: number | null;
  }>;
  /**
   * 明确「测过但没有值」的时间点。
   *
   * 后端一小时窗口会为没测到的槽位下发 null，这些点必须和「后端压根没给点」区分开：
   * 前者是真的空档，要留空；后者（例如窗口最新一格不在 2 分钟网格上）应该由上一个
   * 样本延续过去，否则图表会凭空缺一格。
   */
  emptyTimes?: number[];
  max: number;
  loss: number | null;
}

export interface HomepagePingLine extends PingOverviewItem {
  taskId: number;
  taskName: string;
}

export interface HomepagePingDisplayLine extends HomepagePingLine {
  buckets: PingOverviewBucket[];
}

export interface TrafficTrendSample {
  value: number;
  level: number;
  opacity: number;
}

export interface PingOverviewBucket {
  index: number;
  value: number | null;
  loss: number | null;
  total: number;
  lost: number;
  startAt: number | null;
  endAt: number | null;
  /** 整格都落在节点掉线之后：柱子涂红，而不是当成「没采到」的空格。 */
  offline?: boolean;
}

/** 登录态。CF-Server-Monitor 没有 /api/me，由 /api/config 的 authorization 推导。 */
export interface Me {
  logged_in: boolean;
  username: string;
  uuid: string;
}

/** 站点配置的展示模型，字段名沿用主题内既有约定。 */
export interface PublicConfig {
  sitename: string;
  description: string;
  version: string;
  latestVersion: string;
  private_site: boolean;
  /** 这次请求带的令牌后端认不认（`/api/config` 的 `authorization`）。登录态由它推导，见 `resolveMe`。 */
  authorization: boolean;
  turnstile_enabled: boolean;
  turnstile_site_key: string;
  verified: boolean;
  theme_settings: Record<string, unknown>;
  sys: SysConfig;
  /** 后端下发的首页延迟窗口口径；缺席时前端从数据自推跨度。见 `SiteConfigSchema.latency_window`。 */
  latencyWindow?: { points?: number; hours?: number };
  /** 单次实时连接的时长上限（分钟，0 = 不限）。见 `SiteConfigSchema.frontend_ws_timeout_minutes`。 */
  frontendWsTimeoutMinutes?: number;
  /** 后台「默认外观」换算成主题的外观值；老后端不下发时缺席。见 `resolvePreferredAppearance`。 */
  preferredAppearance?: "system" | "light" | "dark";
  /**
   * 各条线路的显示名：后端 `custom_*_name` / `node_N_name` 逐条覆盖，缺的沿用主题默认名。
   * 后端没下发任何一条时是 `DEFAULT_CARRIER_NAMES` 那个常量本身（引用稳定）。
   */
  carrierNames: CarrierNames;
}
