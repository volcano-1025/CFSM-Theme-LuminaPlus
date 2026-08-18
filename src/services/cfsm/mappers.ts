import type { PingLiveSample } from "@/services/pingLiveStore";
import {
  CfsmServerSchema,
  EMPTY_CARRIER_PING,
  GpuEntrySchema,
  type CarrierPingSnapshot,
  type CfsmServer,
  type DiskIo,
  type GpuEntry,
  type HistoryRow,
  type LoadRecord,
  type NodeInfo,
  type NodeMetrics,
  type PingRecord,
  type PingTask,
} from "@/types/cfsm";

/** 后端内存/磁盘字段的单位是 MiB，流量配额是 GB。 */
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** 与后端 `/api/servers` 聚合统计一致的在线判定阈值。 */
export const ONLINE_THRESHOLD_MS = 300_000;

/** 四条固定线路。CF-Server-Monitor 的探测点是固定的，没有可配置的 ping 任务。 */
export const CARRIER_TASKS = [
  { id: 1, key: "ct", name: "电信", field: "ping_ct", lossField: "loss_ct" },
  { id: 2, key: "cu", name: "联通", field: "ping_cu", lossField: "loss_cu" },
  { id: 3, key: "cm", name: "移动", field: "ping_cm", lossField: "loss_cm" },
  { id: 4, key: "bd", name: "BD", field: "ping_bd", lossField: "loss_bd" },
] as const;

export type CarrierTask = (typeof CARRIER_TASKS)[number];

export const CARRIER_TASK_BY_ID = new Map<number, CarrierTask>(
  CARRIER_TASKS.map((task) => [task.id, task]),
);

export function carrierPingTasks(): PingTask[] {
  return CARRIER_TASKS.map((task) => ({
    id: task.id,
    interval: 60,
    name: task.name,
    loss: 0,
    clients: [],
    type: "icmp",
    target: "",
    weight: task.id,
  }));
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 秒级或毫秒级时间戳统一成毫秒。
 *
 * 字符串只有整体是数字时才按时间戳解析：`"2026-07-16T00:00:00Z"` 被 parseFloat 读成 2026，
 * 必须交给 Date.parse 而不是当成秒。
 */
export function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string") return 0;

  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number.parseFloat(trimmed);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return num < 10_000_000_000 ? num * 1000 : num;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `"0.10 0.20 0.30"` → `[0.1, 0.2, 0.3]`，缺位补 0。 */
export function parseLoadAvg(value: unknown): [number, number, number] {
  const parts = String(value ?? "")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((part) => toNumber(part, 0));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * `gpu_info` 在实时数据里是数组，在 REST 历史/详情里可能是同结构的 JSON 字符串。
 */
export function parseGpuInfo(value: unknown): GpuEntry[] {
  let raw: unknown = value;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "null" || trimmed === "[]") return [];
    try {
      raw = JSON.parse(trimmed);
    } catch {
      // 非 JSON 时当成单纯的型号名。
      return [{ id: "0", name: trimmed, info: null }];
    }
  }
  if (!Array.isArray(raw)) return [];

  const out: GpuEntry[] = [];
  for (const item of raw) {
    const parsed = GpuEntrySchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function gpuDisplayName(entries: GpuEntry[]): string {
  return entries
    .map((entry) => entry.name.trim())
    .filter(Boolean)
    .join(", ");
}

export function gpuUsagePercent(entries: GpuEntry[]): number {
  const values = entries
    .map((entry) => entry.info)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return 0;
  return Math.max(...values);
}

/**
 * 配额单位是 GB（后台输入框即以 GB 计）。为兼容手填的 `"1TB"` 这类值，
 * 带单位后缀时按后缀换算。
 */
export function parseTrafficLimitBytes(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const match = raw.match(/^(-?[\d.]+)\s*([a-zA-Z]*)$/);
  if (!match) return 0;
  const amount = toNumber(match[1], 0);
  if (!(amount > 0)) return 0;

  switch (match[2]!.toLowerCase()) {
    case "":
    case "g":
    case "gb":
    case "gib":
      return amount * GIB;
    case "t":
    case "tb":
    case "tib":
      return amount * GIB * 1024;
    case "m":
    case "mb":
    case "mib":
      return amount * MIB;
    case "p":
    case "pb":
    case "pib":
      return amount * GIB * 1024 * 1024;
    default:
      return amount * GIB;
  }
}

/** CF-Server-Monitor 的 total/ul/dl/max 归一化成主题内部的 sum/up/down/max。 */
export function normalizeTrafficCalcType(value: unknown): string {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "ul":
    case "up":
      return "up";
    case "dl":
    case "down":
      return "down";
    case "max":
      return "max";
    case "min":
      return "min";
    default:
      return "sum";
  }
}

/**
 * `price` 为 `"0"` 或 `"-1"` 表示免费，空串表示未设置。
 *
 * `-1` 原样保留：那是站长显式标记的「免费」，卡片会显示「免费」而不是留空；
 * 费用统计对 `price <= 0` 一视同仁，不受影响。其余负数按未设置处理。
 */
export function parsePrice(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const num = toNumber(raw.replace(/,/g, ""), 0);
  if (num === -1) return -1;
  if (num < 0) return 0;
  return num;
}

export function isServerOnline(server: CfsmServer, now = Date.now()): boolean {
  if (typeof server.is_online === "boolean") return server.is_online;
  const lastUpdated = normalizeTimestamp(server.last_updated || server.timestamp);
  return lastUpdated > 0 && now - lastUpdated < ONLINE_THRESHOLD_MS;
}

export function toNodeInfo(server: CfsmServer): NodeInfo {
  const gpus = parseGpuInfo(server.gpu_info);
  return {
    uuid: server.id,
    name: server.name,
    group: server.server_group,
    region: server.region,
    hidden: String(server.is_hidden) === "1",
    cpu_name: server.cpu_info,
    cpu_cores: server.cpu_cores,
    arch: server.arch,
    os: server.os,
    kernel_version: server.kernel_version,
    gpu_name: gpuDisplayName(gpus),
    mem_total: server.ram_total * MIB,
    swap_total: server.swap_total * MIB,
    disk_total: server.disk_total * MIB,
    weight: server.sort_order,
    price: parsePrice(server.price),
    billing_cycle: server.billing_cycle,
    auto_renewal: String(server.auto_renewal) === "1",
    currency: server.currency,
    expired_at: server.expire_date,
    tags: server.tags,
    // note 是管理端内部字段，公共接口不返回。
    public_remark: "",
    traffic_limit: parseTrafficLimitBytes(server.traffic_limit),
    traffic_limit_type: normalizeTrafficCalcType(server.traffic_calc_type),
    traffic_reset_day: server.reset_day,
    report_interval: server.report_interval,
    agent_version: server.agent_version,
    // 公共接口只给可达性标记，不给具体地址。
    ipv4: String(server.ip_v4) === "1" ? "1" : "",
    ipv6: String(server.ip_v6) === "1" ? "1" : "",
    created_at: "",
    updated_at: String(normalizeTimestamp(server.last_updated) || ""),
  };
}

export function carrierPingFromServer(server: CfsmServer): CarrierPingSnapshot {
  return {
    ct: toNullableNumber(server.ping_ct),
    cu: toNullableNumber(server.ping_cu),
    cm: toNullableNumber(server.ping_cm),
    bd: toNullableNumber(server.ping_bd),
    lossCt: toNullableNumber(server.loss_ct),
    lossCu: toNullableNumber(server.loss_cu),
    lossCm: toNullableNumber(server.loss_cm),
    lossBd: toNullableNumber(server.loss_bd),
  };
}

/**
 * Workers 2.8.3 Beta2 起，`/api/servers` 直接给出每台节点最近一小时的探测窗口：
 * 30 个槽位、每 2 分钟一个，`ping` 与 `loss` 两个数组按时间戳对应。
 *
 * 有它就不必再靠浏览器慢慢累积，首屏就是完整的一小时；旧版后端没有这两个字段，
 * 返回空数组，调用方回落到实时累积。
 */
export function parseLatencyWindow(server: CfsmServer): PingLiveSample[] {
  const pingPoints = Array.isArray(server.ping) ? server.ping : [];
  if (pingPoints.length === 0) return [];

  const lossByTs = new Map<number, (typeof pingPoints)[number]>();
  for (const point of Array.isArray(server.loss) ? server.loss : []) {
    const time = normalizeTimestamp(point.ts);
    if (time > 0) lossByTs.set(time, point);
  }

  const out: PingLiveSample[] = [];
  for (const point of pingPoints) {
    const time = normalizeTimestamp(point.ts);
    if (time <= 0) continue;
    const loss = lossByTs.get(time);
    out.push({
      time,
      ping: {
        ct: point.ct ?? null,
        cu: point.cu ?? null,
        cm: point.cm ?? null,
        bd: point.bd ?? null,
        lossCt: loss?.ct ?? null,
        lossCu: loss?.cu ?? null,
        lossCm: loss?.cm ?? null,
        lossBd: loss?.bd ?? null,
      },
    });
  }
  return out.sort((left, right) => left.time - right.time);
}

function sameCarrierPing(a: CarrierPingSnapshot, b: CarrierPingSnapshot): boolean {
  return (
    a.ct === b.ct &&
    a.cu === b.cu &&
    a.cm === b.cm &&
    a.bd === b.bd &&
    a.lossCt === b.lossCt &&
    a.lossCu === b.lossCu &&
    a.lossCm === b.lossCm &&
    a.lossBd === b.lossBd
  );
}

function sameDiskIo(a: DiskIo | null, b: DiskIo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.read_bps === b.read_bps &&
    a.write_bps === b.write_bps &&
    a.read_iops === b.read_iops &&
    a.write_iops === b.write_iops &&
    a.await_ms === b.await_ms &&
    a.util === b.util
  );
}

export function toNodeMetrics(
  server: CfsmServer,
  now = Date.now(),
  previous?: NodeMetrics,
): NodeMetrics {
  const [load1, load5, load15] = parseLoadAvg(server.load_avg);
  const gpus = parseGpuInfo(server.gpu_info);
  const ramUsed = server.ram_used * MIB;
  const ramTotal = server.ram_total * MIB;
  const diskUsed = server.disk_used * MIB;
  const diskTotal = server.disk_total * MIB;
  const bootTime = normalizeTimestamp(server.boot_time);
  const updatedAt = normalizeTimestamp(server.last_updated || server.timestamp);
  const ping = carrierPingFromServer(server);

  const next: NodeMetrics = {
    online: isServerOnline(server, now),
    cpuPct: server.cpu,
    ramUsed,
    ramTotal,
    ramPct: ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0,
    swapUsed: server.swap_used * MIB,
    swapTotal: server.swap_total * MIB,
    diskUsed,
    diskTotal,
    diskPct: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
    netUp: server.net_out_speed,
    netDown: server.net_in_speed,
    trafficUp: server.net_tx,
    trafficDown: server.net_rx,
    trafficUpMonthly: server.net_tx_monthly,
    trafficDownMonthly: server.net_rx_monthly,
    uptime: bootTime > 0 ? Math.max(0, Math.floor((now - bootTime) / 1000)) : 0,
    load1,
    load5,
    load15,
    process: server.processes,
    connectionsTcp: server.tcp_conn,
    connectionsUdp: server.udp_conn,
    gpuPct: gpuUsagePercent(gpus),
    gpuName: gpuDisplayName(gpus),
    diskIo: server.disk ?? null,
    ping: previous && sameCarrierPing(previous.ping, ping) ? previous.ping : ping,
    updatedAt,
  };

  if (previous && sameDiskIo(previous.diskIo, next.diskIo)) {
    next.diskIo = previous.diskIo;
  }
  return next;
}

export function emptyNodeMetrics(info: NodeInfo, online: boolean | null): NodeMetrics {
  return {
    online,
    cpuPct: 0,
    ramUsed: 0,
    ramTotal: info.mem_total,
    ramPct: 0,
    swapUsed: 0,
    swapTotal: info.swap_total,
    diskUsed: 0,
    diskTotal: info.disk_total,
    diskPct: 0,
    netUp: 0,
    netDown: 0,
    trafficUp: 0,
    trafficDown: 0,
    trafficUpMonthly: 0,
    trafficDownMonthly: 0,
    uptime: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    process: 0,
    connectionsTcp: 0,
    connectionsUdp: 0,
    gpuPct: 0,
    gpuName: info.gpu_name,
    diskIo: null,
    ping: EMPTY_CARRIER_PING,
    updatedAt: 0,
  };
}

/** WebSocket 增量样本里出现的数值字段，合并前统一转成数字。 */
const NUMERIC_PATCH_FIELDS = new Set([
  "cpu",
  "net_in_speed",
  "net_out_speed",
  "net_rx",
  "net_tx",
  "net_rx_monthly",
  "net_tx_monthly",
  "processes",
  "tcp_conn",
  "udp_conn",
  "ram_total",
  "ram_used",
  "swap_total",
  "swap_used",
  "disk_total",
  "disk_used",
  "cpu_cores",
  "last_updated",
  "timestamp",
  "sort_order",
  "reset_day",
  "report_interval",
]);

const NULLABLE_NUMERIC_PATCH_FIELDS = new Set([
  "ping_ct",
  "ping_cu",
  "ping_cm",
  "ping_bd",
  "loss_ct",
  "loss_cu",
  "loss_cm",
  "loss_bd",
]);

/**
 * 把一条增量样本合并进已知的服务器状态。
 *
 * 样本是增量的：高频采样点只带 CPU/内存/Swap/网速，每次上报的最后一个样本才额外携带
 * 磁盘容量、磁盘 IO、GPU、进程数、连接数、Ping 等报告级字段。因此这里只覆盖出现过的键。
 */
export function mergeServerPatch(
  base: CfsmServer,
  patch: Record<string, unknown>,
  sampleTs?: number,
): CfsmServer {
  const next: Record<string, unknown> = { ...base };
  let changed = false;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    let normalized: unknown = value;
    if (NUMERIC_PATCH_FIELDS.has(key)) {
      normalized = toNumber(value, toNumber(next[key], 0));
    } else if (NULLABLE_NUMERIC_PATCH_FIELDS.has(key)) {
      normalized = toNullableNumber(value);
    } else if (key === "disk") {
      // disk 缺失/全零时后端不会下发，收到时整体替换。
      normalized = value;
    }
    if (next[key] !== normalized) {
      next[key] = normalized;
      changed = true;
    }
  }

  const ts = normalizeTimestamp(sampleTs ?? patch.ts ?? patch.timestamp ?? 0);
  if (ts > 0 && toNumber(next.last_updated, 0) !== ts) {
    next.last_updated = ts;
    next.timestamp = ts;
    changed = true;
  }

  if (!changed) return base;

  const parsed = CfsmServerSchema.safeParse(next);
  return parsed.success ? parsed.data : base;
}

/* ------------------------------------------------------------------ *
 * 历史数据
 * ------------------------------------------------------------------ */

export function historyRowToLoadRecord(row: HistoryRow, client: string): LoadRecord {
  const [load1] = parseLoadAvg(row.load_avg);
  const gpus = parseGpuInfo(row.gpu_info);
  return {
    cpu: row.cpu,
    gpu: gpuUsagePercent(gpus),
    ram: row.ram_used * MIB,
    ram_total: row.ram_total * MIB,
    swap: row.swap_used * MIB,
    swap_total: row.swap_total * MIB,
    load: load1,
    // CF-Server-Monitor 不采集温度。
    temp: 0,
    disk: row.disk_used * MIB,
    disk_total: row.disk_total * MIB,
    // 后端两种下发形态都见过：嵌套的 disk 对象与扁平的 disk_read_bps 字段。
    // 两者都没有说明探针没采集，保持 null 让图表退回显示已用空间。
    disk_read: toNullableNumber(row.disk?.read_bps ?? row.disk_read_bps),
    disk_write: toNullableNumber(row.disk?.write_bps ?? row.disk_write_bps),
    net_in: row.net_in_speed,
    net_out: row.net_out_speed,
    net_total_up: 0,
    net_total_down: 0,
    process: row.processes,
    connections: row.tcp_conn,
    connections_udp: row.udp_conn,
    time: normalizeTimestamp(row.timestamp),
    client,
  };
}

/** 历史行 → 四条线路的 ping 记录；缺测的线路不产出点。 */
export function historyRowsToPingRecords(rows: HistoryRow[], client: string): PingRecord[] {
  const out: PingRecord[] = [];
  for (const row of rows) {
    const time = normalizeTimestamp(row.timestamp);
    if (time <= 0) continue;
    for (const task of CARRIER_TASKS) {
      const value = toNullableNumber(row[task.field]);
      if (value == null || value < 0) continue;
      out.push({
        task_id: task.id,
        time,
        value,
        client,
        count: 1,
        loss: toNullableNumber(row[task.lossField]),
      });
    }
  }
  return out;
}

/**
 * 历史行 → 首页延迟条用的样本。
 *
 * 用户点开详情页时本来就查了这台节点的历史，顺手把真实采样回灌进首页缓冲 ——
 * 不额外打后端（调用方已经拿到了历史；首页异常恢复也复用同一回调），但看过/回填过的节点，
 * 首页那一小时就不必再靠 `/api/servers` 那份向后填充的窗口凑。
 */
export function historyRowsToPingSamples(rows: HistoryRow[]): PingLiveSample[] {
  const out: PingLiveSample[] = [];
  for (const row of rows) {
    const time = normalizeTimestamp(row.timestamp);
    if (time <= 0) continue;
    const ping: CarrierPingSnapshot = {
      ct: toNullableNumber(row.ping_ct),
      cu: toNullableNumber(row.ping_cu),
      cm: toNullableNumber(row.ping_cm),
      bd: toNullableNumber(row.ping_bd),
      lossCt: toNullableNumber(row.loss_ct),
      lossCu: toNullableNumber(row.loss_cu),
      lossCm: toNullableNumber(row.loss_cm),
      lossBd: toNullableNumber(row.loss_bd),
    };
    out.push({ time, ping });
  }
  return out.sort((left, right) => left.time - right.time);
}

/** 采样间隔：取相邻时间戳差值的中位数，供图表判断断点。 */
export function inferIntervalSeconds(times: number[]): number | undefined {
  const sorted = [...new Set(times.filter((time) => time > 0))].sort((a, b) => a - b);
  if (sorted.length < 2) return undefined;

  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i]! - sorted[i - 1]!;
    if (delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return undefined;

  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)]!;
  return Math.max(1, Math.round(median / 1000));
}
