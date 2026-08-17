import { z } from "zod";

/**
 * 上半部分是 CF-Server-Monitor 后端的原始响应结构（宽松解析，容忍字段缺失/类型漂移），
 * 下半部分是主题内部的展示模型。两者之间由 `@/services/cfsm/mappers` 转换。
 */

const looseString = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((v) => String(v))
  .catch("");
const looseNumber = z
  .union([z.number(), z.string()])
  .transform((v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    const parsed = Number.parseFloat(v);
    return Number.isFinite(parsed) ? parsed : 0;
  })
  .catch(0);
const nullableNumber = z
  .union([z.number(), z.string(), z.null()])
  .transform((v) => {
    if (v == null) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const parsed = Number.parseFloat(v);
    return Number.isFinite(parsed) ? parsed : null;
  })
  .nullish()
  .catch(null);
/** 磁盘 IO；旧探针或全零时后端不会下发该对象。 */
export const DiskIoSchema = z
  .object({
    read_bps: looseNumber.default(0),
    write_bps: looseNumber.default(0),
    read_iops: looseNumber.default(0),
    write_iops: looseNumber.default(0),
    await_ms: looseNumber.default(0),
    util: looseNumber.default(0),
  })
  .passthrough();

export type DiskIo = z.output<typeof DiskIoSchema>;

export const GpuEntrySchema = z
  .object({
    id: looseString.default(""),
    name: looseString.default(""),
    info: nullableNumber,
  })
  .passthrough();

export type GpuEntry = z.output<typeof GpuEntrySchema>;

/**
 * `/api/servers` 下发的一小时探测窗口中的一个点。
 *
 * 固定 30 个槽位、每 2 分钟一个，`ping` 与 `loss` 各一个数组。
 * 线路值可能是 `false`（该节点禁用了这条线路），这里统一归一成 null。
 */
export const LatencyPointSchema = z
  .object({
    ts: looseNumber.default(0),
    ct: nullableNumber,
    cu: nullableNumber,
    cm: nullableNumber,
    bd: nullableNumber,
  })
  .passthrough();

export type LatencyPoint = z.output<typeof LatencyPointSchema>;

/**
 * `/api/servers` 与 `/api/server` 的服务器对象。
 *
 * 单位约定（与后端一致）：`ram_*` / `swap_*` / `disk_*` 为 MiB，网络速率与累计量为字节，
 * `traffic_limit` 为 GB，`boot_time` / `last_updated` 为毫秒时间戳。
 */
export const CfsmServerSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform((v) => String(v)),
    name: looseString.default(""),
    server_group: looseString.default(""),
    tags: looseString.default(""),
    price: looseString.default(""),
    billing_cycle: looseString.default(""),
    auto_renewal: looseString.default(""),
    currency: looseString.default(""),
    expire_date: looseString.default(""),
    traffic_limit: looseString.default(""),
    traffic_calc_type: looseString.default(""),
    reset_day: looseNumber.default(0),
    report_interval: looseNumber.default(0),
    is_hidden: looseString.default("0"),
    sort_order: looseNumber.default(0),

    cpu: looseNumber.default(0),
    load_avg: looseString.default(""),
    net_in_speed: looseNumber.default(0),
    net_out_speed: looseNumber.default(0),
    net_rx: looseNumber.default(0),
    net_tx: looseNumber.default(0),
    net_rx_monthly: looseNumber.default(0),
    net_tx_monthly: looseNumber.default(0),
    processes: looseNumber.default(0),
    tcp_conn: looseNumber.default(0),
    udp_conn: looseNumber.default(0),

    ping_ct: nullableNumber,
    ping_cu: nullableNumber,
    ping_cm: nullableNumber,
    ping_bd: nullableNumber,
    loss_ct: nullableNumber,
    loss_cu: nullableNumber,
    loss_cm: nullableNumber,
    loss_bd: nullableNumber,
    // Workers 2.8.3 Beta2 起下发的一小时探测窗口；旧版本没有这两个字段。
    ping: z.array(LatencyPointSchema).optional(),
    loss: z.array(LatencyPointSchema).optional(),

    ram_total: looseNumber.default(0),
    ram_used: looseNumber.default(0),
    swap_total: looseNumber.default(0),
    swap_used: looseNumber.default(0),
    disk_total: looseNumber.default(0),
    disk_used: looseNumber.default(0),
    disk: DiskIoSchema.optional(),

    cpu_cores: looseNumber.default(0),
    cpu_info: looseString.default(""),
    gpu_info: z.unknown().optional(),
    arch: looseString.default(""),
    os: looseString.default(""),
    kernel_version: looseString.default(""),
    region: looseString.default(""),
    ip_v4: looseString.default("0"),
    ip_v6: looseString.default("0"),
    boot_time: looseString.default(""),
    agent_version: looseString.default(""),
    last_updated: looseNumber.default(0),
    timestamp: looseNumber.default(0),
    is_online: z.boolean().optional(),
  })
  .passthrough();

export type CfsmServer = z.output<typeof CfsmServerSchema>;

/** WebSocket / latestReportUpdates 下发的增量样本，字段是 Server 的子集。 */
export const CfsmServerPatchSchema = CfsmServerSchema.partial().passthrough();

export type CfsmServerPatch = Partial<CfsmServer> & Record<string, unknown>;

export const LatestReportUpdateSchema = z
  .object({
    serverId: z.union([z.string(), z.number()]).transform((v) => String(v)),
    reportTs: looseNumber.optional(),
    reportAgeMs: looseNumber.optional(),
    samples: z
      .array(
        z
          .object({
            ts: looseNumber.optional(),
            data: z.record(z.string(), z.unknown()).optional(),
            payload: z.record(z.string(), z.unknown()).optional(),
            metrics: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type LatestReportUpdate = z.output<typeof LatestReportUpdateSchema>;

export const SysConfigSchema = z
  .object({
    show_price: z.boolean().default(true),
    show_expire: z.boolean().default(true),
    show_tf: z.boolean().default(true),
    show_time: z.boolean().default(true),
    long_history_points: looseNumber.optional(),
    display_mode: looseString.optional(),
  })
  .passthrough();

export type SysConfig = z.output<typeof SysConfigSchema>;

export const ServersResponseSchema = z
  .object({
    servers: z.array(CfsmServerSchema).default([]),
    latestReportUpdates: z.array(LatestReportUpdateSchema).default([]),
    stats: z
      .object({
        total: looseNumber.default(0),
        online: looseNumber.default(0),
        offline: looseNumber.default(0),
        globalSpeedIn: looseNumber.default(0),
        globalSpeedOut: looseNumber.default(0),
        globalNetTx: looseNumber.default(0),
        globalNetRx: looseNumber.default(0),
      })
      .partial()
      .passthrough()
      .default({}),
    regionStats: z.record(z.string(), looseNumber).default({}),
    sysConfig: SysConfigSchema.default({}),
  })
  .passthrough();

export type ServersResponse = z.output<typeof ServersResponseSchema>;

export const SiteConfigSchema = z
  .object({
    version: looseString.default(""),
    last_workers_version: looseString.nullish().transform((v) => v ?? ""),
    last_agent_version: looseString.nullish().transform((v) => v ?? ""),
    is_public: z.boolean().default(true),
    authorization: z.boolean().default(false),
    turnstile_enabled: z.boolean().default(false),
    turnstile_login_enabled: z.boolean().default(false),
    turnstile_site_key: looseString.default(""),
    site_title: looseString.default(""),
    display_mode: looseString.default(""),
    theme_options: z.record(z.string(), z.unknown()).default({}),
    verified: z.boolean().default(false),
    turnstile_verified: looseString.nullish().transform((v) => v ?? ""),
    long_history_points: looseNumber.default(120),
  })
  .passthrough();

export type SiteConfig = z.output<typeof SiteConfigSchema>;

/** `/api/history/all` 的一行；字段随后端列定义，缺失时按 0 处理。 */
export const HistoryRowSchema = z
  .object({
    timestamp: looseNumber.default(0),
    cpu: looseNumber.default(0),
    gpu_info: z.unknown().optional(),
    ram_total: looseNumber.default(0),
    ram_used: looseNumber.default(0),
    swap_total: looseNumber.default(0),
    swap_used: looseNumber.default(0),
    disk_total: looseNumber.default(0),
    disk_used: looseNumber.default(0),
    disk: DiskIoSchema.optional(),
    disk_read_bps: looseNumber.optional(),
    disk_write_bps: looseNumber.optional(),
    disk_read_iops: looseNumber.optional(),
    disk_write_iops: looseNumber.optional(),
    disk_await_ms: looseNumber.optional(),
    disk_util: looseNumber.optional(),
    processes: looseNumber.default(0),
    net_in_speed: looseNumber.default(0),
    net_out_speed: looseNumber.default(0),
    tcp_conn: looseNumber.default(0),
    udp_conn: looseNumber.default(0),
    ping_ct: nullableNumber,
    ping_cu: nullableNumber,
    ping_cm: nullableNumber,
    ping_bd: nullableNumber,
    loss_ct: nullableNumber,
    loss_cu: nullableNumber,
    loss_cm: nullableNumber,
    loss_bd: nullableNumber,
    load_avg: looseString.default(""),
    kernel_version: looseString.default(""),
  })
  .passthrough();

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
  /** 四线路实时延迟/丢包，缺测为 null。 */
  ping: CarrierPingSnapshot;
  updatedAt: number;
}

export type CarrierKey = "ct" | "cu" | "cm" | "bd";

export interface CarrierPingSnapshot {
  ct: number | null;
  cu: number | null;
  cm: number | null;
  bd: number | null;
  lossCt: number | null;
  lossCu: number | null;
  lossCm: number | null;
  lossBd: number | null;
}

export const EMPTY_CARRIER_PING: CarrierPingSnapshot = {
  ct: null,
  cu: null,
  cm: null,
  bd: null,
  lossCt: null,
  lossCu: null,
  lossCm: null,
  lossBd: null,
};

export interface ThemeSettings {
  defaultAppearance?: "system" | "light" | "dark";
  desktopNodeViewMode?: "large" | "compact" | "mini" | "list";
  mobileNodeViewMode?: "large" | "compact" | "mini" | "list";
  enableAdminButton?: boolean;
  showPingChart?: boolean;
  homepagePingBindings?: Record<string, string[]>;
  enableHomepageMultiPing?: boolean;
  homepageMultiPingTaskIds?: number[];
  fakePingForUnbound?: boolean;
  showHomeOverview?: boolean;
  showGroupTabs?: boolean;
  showRegionBar?: boolean;
  showCardGroup?: boolean;
  homeGroupOrder?: string[];
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
  showTodayTrafficPopover?: boolean;
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
  load: number;
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
  turnstile_enabled: boolean;
  turnstile_site_key: string;
  verified: boolean;
  theme_settings: Record<string, unknown>;
  sys: SysConfig;
}
