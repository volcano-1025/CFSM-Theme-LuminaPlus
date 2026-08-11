import { z } from "zod";
import {
  CfsmServerSchema,
  HistoryRowSchema,
  ServersResponseSchema,
  SiteConfigSchema,
  type CfsmServer,
  type HistoryRow,
  type LoadRecordsResponse,
  type Me,
  type NodeInfo,
  type PingRecordsResponse,
  type PingTaskStats,
  type PublicConfig,
  type SysConfig,
} from "@/types/cfsm";
import { getJwtToken } from "@/services/cfsm/config";
import {
  ApiRequestError,
  cfsmGet,
  cfsmGetAll,
  type RequestOptions,
} from "@/services/cfsm/http";
import {
  CARRIER_TASKS,
  carrierPingTasks,
  historyRowToLoadRecord,
  historyRowsToPingRecords,
  inferIntervalSeconds,
  toNodeInfo,
} from "@/services/cfsm/mappers";

export { ApiRequestError, DatabaseUpgradeRequiredError } from "@/services/cfsm/http";

/** 后端支持的历史查询时长档位（小时）。 */
export const HISTORY_HOURS_OPTIONS = [0.167, 0.5, 1, 6, 12, 24, 48, 96, 168] as const;

/** 未登录用户查询超过 24 小时会被拒绝。 */
export const ANONYMOUS_MAX_HISTORY_HOURS = 24;

const degradeWarned = new Set<string>();
export function warnDegradedOnce(key: string, message: string) {
  if (degradeWarned.has(key)) return;
  degradeWarned.add(key);
  console.warn(`[LuminaPlus] ${message}`);
}

/** serverId → 拥有它的后端地址。多站部署时详情/历史必须打到正确的站点。 */
const serverBaseIndex = new Map<string, string>();

export function getServerApiBase(serverId: string): string | undefined {
  return serverBaseIndex.get(serverId);
}

function rememberServerBases(base: string, servers: CfsmServer[]) {
  for (const server of servers) {
    if (server.id) serverBaseIndex.set(server.id, base);
  }
}

/** 把后端时长参数收敛到受支持的档位，避免 400。 */
export function normalizeHistoryHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 24;
  let closest = HISTORY_HOURS_OPTIONS[0] as number;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const option of HISTORY_HOURS_OPTIONS) {
    const delta = Math.abs(option - hours);
    if (delta < bestDelta) {
      bestDelta = delta;
      closest = option;
    }
  }
  return closest;
}

/* ------------------------------------------------------------------ *
 * 站点配置
 * ------------------------------------------------------------------ */

export async function getSiteConfig(options?: RequestOptions) {
  return cfsmGet("/api/config", SiteConfigSchema, options);
}

/**
 * 站点配置的展示模型。CF-Server-Monitor 没有站点简介字段，描述留空。
 */
export async function getPublic(options?: RequestOptions): Promise<PublicConfig> {
  const config = await getSiteConfig(options);
  return {
    sitename: config.site_title,
    description: "",
    version: config.version,
    latestVersion: config.last_workers_version,
    private_site: !config.is_public,
    turnstile_enabled: config.turnstile_enabled,
    turnstile_site_key: config.turnstile_site_key,
    verified: config.verified,
    // 第三方主题的自定义配置是只读的，只作为主题设置的默认值来源。
    theme_settings: config.theme_options,
    sys: {
      show_price: true,
      show_expire: true,
      show_tf: true,
      show_time: true,
      long_history_points: config.long_history_points,
    } as SysConfig,
  };
}

/**
 * CF-Server-Monitor 没有 `/api/me`：登录态由 `/api/config` 的 `authorization` 决定，
 * 令牌本身存在 localStorage 里由 `/admin` 登录时写入。
 */
export async function getMe(options?: RequestOptions): Promise<Me> {
  if (!getJwtToken()) {
    return { logged_in: false, username: "", uuid: "" };
  }
  const config = await getSiteConfig(options);
  return {
    logged_in: config.authorization,
    username: config.authorization ? "admin" : "",
    uuid: "",
  };
}

/* ------------------------------------------------------------------ *
 * 服务器列表
 * ------------------------------------------------------------------ */

export interface ServersSnapshot {
  servers: CfsmServer[];
  /** serverId → 所属后端，供 WebSocket 与详情请求分流。 */
  baseByServerId: Map<string, string>;
  sysConfig: SysConfig;
  regionStats: Record<string, number>;
  stats: AggregatedStats;
  /** 至少有一个后端成功返回。 */
  partial: boolean;
}

export interface AggregatedStats {
  total: number;
  online: number;
  offline: number;
  globalSpeedIn: number;
  globalSpeedOut: number;
  globalNetTx: number;
  globalNetRx: number;
}

const STATS_KEYS = [
  "total",
  "online",
  "offline",
  "globalSpeedIn",
  "globalSpeedOut",
  "globalNetTx",
  "globalNetRx",
] as const;

function emptyStats(): AggregatedStats {
  return {
    total: 0,
    online: 0,
    offline: 0,
    globalSpeedIn: 0,
    globalSpeedOut: 0,
    globalNetTx: 0,
    globalNetRx: 0,
  };
}

/**
 * 拉取全部后端的服务器列表并合并。多站部署下单站失败不阻塞其它站，
 * 但全部失败时抛出第一个错误，让上层进入错误态而不是渲染空列表。
 */
export async function getServersSnapshot(
  options?: Omit<RequestOptions, "base">,
): Promise<ServersSnapshot> {
  const results = await cfsmGetAll("/api/servers", ServersResponseSchema, options);

  const servers: CfsmServer[] = [];
  const baseByServerId = new Map<string, string>();
  const regionStats: Record<string, number> = {};
  const stats = emptyStats();
  let sysConfig: SysConfig | null = null;
  let succeeded = 0;
  let firstError: unknown = null;

  for (const result of results) {
    if (!result.data) {
      firstError ??= result.error;
      continue;
    }
    succeeded += 1;

    const seen = new Set<string>();
    for (const server of result.data.servers) {
      // 同一 ID 在多站同时出现时以第一个站为准，避免重复卡片。
      if (!server.id || seen.has(server.id) || baseByServerId.has(server.id)) continue;
      seen.add(server.id);
      baseByServerId.set(server.id, result.base);
      servers.push(server);
    }
    rememberServerBases(result.base, result.data.servers);

    for (const [region, count] of Object.entries(result.data.regionStats)) {
      regionStats[region] = (regionStats[region] ?? 0) + Number(count ?? 0);
    }
    for (const key of STATS_KEYS) {
      stats[key] += Number(result.data.stats[key] ?? 0);
    }
    // 站点开关取第一个成功站点的配置。
    sysConfig ??= result.data.sysConfig;
  }

  if (succeeded === 0) {
    throw firstError instanceof Error
      ? firstError
      : new Error("All API bases failed to return /api/servers");
  }

  return {
    servers,
    baseByServerId,
    sysConfig: sysConfig ?? ({} as SysConfig),
    regionStats,
    stats,
    partial: succeeded < results.length,
  };
}

/**
 * 一次性的节点静态信息列表。设置页等只需要 meta 的场景用它，
 * 而不是启动常驻实时 store。
 */
export async function getNodes(
  options?: Omit<RequestOptions, "base">,
): Promise<NodeInfo[]> {
  const snapshot = await getServersSnapshot(options);
  return snapshot.servers
    .map(toNodeInfo)
    .sort((left, right) => left.weight - right.weight);
}

/** 单台服务器详情。带 `latestReportUpdates`，主题目前只用其中的服务器字段。 */
export async function getServerDetail(
  serverId: string,
  options?: RequestOptions,
): Promise<CfsmServer> {
  return cfsmGet(
    `/api/server?${new URLSearchParams({ id: serverId })}`,
    CfsmServerSchema,
    { ...options, base: options?.base ?? getServerApiBase(serverId) },
  );
}

/* ------------------------------------------------------------------ *
 * 历史指标
 * ------------------------------------------------------------------ */

const HistoryResponseSchema = z.array(HistoryRowSchema).catch([]);

async function requestHistoryRows(
  serverId: string,
  hours: number,
  options?: RequestOptions,
): Promise<HistoryRow[]> {
  const params = new URLSearchParams({
    id: serverId,
    hours: String(hours),
  });
  const rows = await cfsmGet(`/api/history/all?${params}`, HistoryResponseSchema, {
    ...options,
    base: options?.base ?? getServerApiBase(serverId),
  });
  // 后端按时间倒序或正序都可能，图表要求升序。
  return [...rows].sort((left, right) => left.timestamp - right.timestamp);
}

/**
 * 历史查询的短期缓存。
 *
 * CF-Server-Monitor 没有批量历史接口，一台节点一次请求；而首页 Ping 概览会为四条线路
 * 分别取数据。缓存让同一节点同一时长的并发/连续请求只打一次后端。
 */
const HISTORY_CACHE_TTL_MS = 20_000;

interface HistoryCacheEntry {
  fetchedAt: number;
  rows: HistoryRow[];
}

const historyCache = new Map<string, HistoryCacheEntry>();
const historyInFlight = new Map<string, Promise<HistoryRow[]>>();

function historyCacheKey(serverId: string, hours: number) {
  return `${serverId}@${hours}`;
}

export function clearHistoryCache(): void {
  historyCache.clear();
  historyInFlight.clear();
}

async function fetchHistoryRows(
  serverId: string,
  hours: number,
  options?: RequestOptions & { cache?: boolean },
): Promise<HistoryRow[]> {
  const normalizedHours = normalizeHistoryHours(hours);
  if (options?.cache === false) {
    return requestHistoryRows(serverId, normalizedHours, options);
  }

  const key = historyCacheKey(serverId, normalizedHours);
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return cached.rows;
  }

  const inFlight = historyInFlight.get(key);
  // 复用在途请求时不能沿用调用方的 signal，否则一个组件卸载会取消所有等待者。
  if (inFlight) return inFlight;

  const request = requestHistoryRows(serverId, normalizedHours, {
    ...options,
    signal: undefined,
  })
    .then((rows) => {
      historyCache.set(key, { fetchedAt: Date.now(), rows });
      return rows;
    })
    .finally(() => {
      historyInFlight.delete(key);
    });
  historyInFlight.set(key, request);
  return request;
}

/** 并发上限，避免几十台节点同时刷新时打爆后端。 */
const HISTORY_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export async function getLoadRecords(
  uuid: string,
  hours = 6,
  options?: RequestOptions,
): Promise<LoadRecordsResponse> {
  const rows = await fetchHistoryRows(uuid, hours, options);
  const records = rows.map((row) => historyRowToLoadRecord(row, uuid));
  const times = records.map((record) => record.time);
  const rangeEndMs = Date.now();
  return {
    count: records.length,
    records,
    rangeStartMs: rangeEndMs - normalizeHistoryHours(hours) * 60 * 60 * 1000,
    rangeEndMs,
    intervalSeconds: inferIntervalSeconds(times),
  };
}

/**
 * Ping 历史。CF-Server-Monitor 的探测点固定为电信/联通/移动/BD 四条线路，
 * 数据与负载共用同一张历史表，因此这里复用同一个请求形状。
 */
export async function getPingRecords(
  uuid: string,
  hours = 6,
  options?: RequestOptions,
): Promise<PingRecordsResponse> {
  const rows = await fetchHistoryRows(uuid, hours, options);
  const records = historyRowsToPingRecords(rows, uuid);
  const rangeEndMs = Date.now();
  const observed = new Set(records.map((record) => record.task_id));
  const tasks = carrierPingTasks().filter((task) => observed.has(task.id));

  return {
    count: records.length,
    records,
    tasks: tasks.length > 0 ? tasks : carrierPingTasks(),
    intervalSeconds: inferIntervalSeconds(rows.map((row) => row.timestamp)),
    rangeStartMs: rangeEndMs - normalizeHistoryHours(hours) * 60 * 60 * 1000,
    rangeEndMs,
    stats: buildPingStats(records, uuid),
  };
}

function buildPingStats(
  records: PingRecordsResponse["records"],
  client: string,
): PingTaskStats[] {
  const byTask = new Map<number, number[]>();
  const lossByTask = new Map<number, { lost: number; total: number }>();

  for (const record of records) {
    const values = byTask.get(record.task_id) ?? [];
    values.push(record.value);
    byTask.set(record.task_id, values);

    const loss = lossByTask.get(record.task_id) ?? { lost: 0, total: 0 };
    loss.total += 1;
    if (typeof record.loss === "number" && record.loss > 0) {
      loss.lost += record.loss / 100;
    }
    lossByTask.set(record.task_id, loss);
  }

  return CARRIER_TASKS.filter((task) => byTask.has(task.id)).map((task) => {
    const values = [...(byTask.get(task.id) ?? [])].sort((a, b) => a - b);
    const loss = lossByTask.get(task.id) ?? { lost: 0, total: 0 };
    const sum = values.reduce((acc, value) => acc + value, 0);
    const avg = values.length > 0 ? sum / values.length : null;
    const p50 = percentile(values, 0.5);
    const p99 = percentile(values, 0.99);
    const variance =
      values.length > 1 && avg != null
        ? values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / (values.length - 1)
        : 0;

    return {
      client,
      taskId: task.id,
      name: task.name,
      type: "icmp",
      interval: 60,
      total: loss.total,
      valid: values.length,
      loss: loss.total > 0 ? (loss.lost / loss.total) * 100 : 0,
      min: values[0] ?? null,
      max: values[values.length - 1] ?? null,
      avg,
      latest: values.length > 0 ? (byTask.get(task.id)!.at(-1) ?? null) : null,
      p50,
      p99,
      stddev: Math.sqrt(variance),
      p99P50Ratio: p50 && p99 ? p99 / p50 : 0,
    };
  });
}

function percentile(sortedValues: number[], fraction: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round(fraction * (sortedValues.length - 1))),
  );
  return sortedValues[index] ?? null;
}

export interface PingOverviewResponse {
  records: PingRecordsResponse["records"];
  tasks: PingRecordsResponse["tasks"];
  rangeStartMs?: number;
  rangeEndMs?: number;
  intervalSeconds?: number;
  stats?: PingTaskStats[];
}

interface PingOverviewOptions {
  signal?: AbortSignal;
  entityIds?: string[];
  includeStats?: boolean;
}

/**
 * 首页 Ping 概览。
 *
 * Komari 的 metric 接口能一次取回多台节点的同一个任务；CF-Server-Monitor 只能按节点查历史，
 * 所以这里按节点并发拉取（带缓存与并发上限），再筛出请求的那条线路。四条线路共享同一份
 * 历史缓存，因此一轮刷新对每台节点只有一次请求。
 */
export async function getPingOverview(
  hours = 1,
  taskId?: number,
  options?: PingOverviewOptions,
): Promise<PingOverviewResponse> {
  const entityIds = Array.from(new Set(options?.entityIds ?? [])).filter(Boolean);
  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - normalizeHistoryHours(hours) * 60 * 60 * 1000;

  if (entityIds.length === 0) {
    return { records: [], tasks: carrierPingTasks(), rangeStartMs, rangeEndMs };
  }

  const perNode = await mapWithConcurrency(entityIds, HISTORY_CONCURRENCY, async (uuid) => {
    if (options?.signal?.aborted) return { uuid, rows: [] as HistoryRow[] };
    try {
      return { uuid, rows: await fetchHistoryRows(uuid, hours, { signal: options?.signal }) };
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      warnDegradedOnce("ping-overview", "部分节点的 Ping 历史获取失败，已跳过这些节点");
      return { uuid, rows: [] as HistoryRow[] };
    }
  });

  const records: PingRecordsResponse["records"] = [];
  const times: number[] = [];
  for (const { uuid, rows } of perNode) {
    times.push(...rows.map((row) => row.timestamp));
    for (const record of historyRowsToPingRecords(rows, uuid)) {
      if (taskId != null && record.task_id !== taskId) continue;
      records.push(record);
    }
  }

  const stats =
    options?.includeStats === false
      ? undefined
      : entityIds.flatMap((uuid) =>
          buildPingStats(
            records.filter((record) => record.client === uuid),
            uuid,
          ),
        );

  return {
    records,
    tasks: carrierPingTasks(),
    rangeStartMs,
    rangeEndMs,
    intervalSeconds: inferIntervalSeconds(times),
    stats,
  };
}

/** 概览统计。数据来自与 getPingOverview 相同的历史缓存，不会产生额外请求。 */
export async function getPingOverviewStats(
  hours: number,
  taskIds: number[],
  options?: { signal?: AbortSignal; entityIds?: string[]; timeout?: number },
): Promise<PingTaskStats[]> {
  const wanted = new Set(taskIds.filter((taskId) => Number.isInteger(taskId) && taskId > 0));
  const entityIds = Array.from(new Set(options?.entityIds ?? [])).filter(Boolean);
  if (wanted.size === 0 || entityIds.length === 0) return [];

  const perNode = await mapWithConcurrency(entityIds, HISTORY_CONCURRENCY, async (uuid) => {
    try {
      return { uuid, rows: await fetchHistoryRows(uuid, hours, { signal: options?.signal }) };
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      return { uuid, rows: [] as HistoryRow[] };
    }
  });

  const out: PingTaskStats[] = [];
  for (const { uuid, rows } of perNode) {
    const records = historyRowsToPingRecords(rows, uuid).filter((record) =>
      wanted.has(record.task_id),
    );
    out.push(...buildPingStats(records, uuid));
  }
  return out;
}

/** Komari 版本用于预热能力探测；这里没有探测步骤，保留空实现以对齐调用点。 */
export function prewarmPingOverviewDependencies(): void {
  // no-op
}

/** 今日流量：由历史里的上/下行速率按采样间隔积分近似得到。 */
export interface TodayTrafficEstimate {
  client: string;
  up: number;
  down: number;
  peakUp: number;
  peakDown: number;
  rangeStartMs: number;
  rangeEndMs: number;
  samples: number;
}

export async function getTodayTrafficEstimate(
  uuid: string,
  startMs: number,
  endMs: number,
  options?: RequestOptions,
): Promise<TodayTrafficEstimate> {
  const spanHours = Math.max(0.167, (endMs - startMs) / 3_600_000);
  const rows = await fetchHistoryRows(uuid, spanHours, options);
  const inRange = rows.filter((row) => {
    const time = row.timestamp;
    return time >= startMs && time <= endMs;
  });

  let up = 0;
  let down = 0;
  let peakUp = 0;
  let peakDown = 0;
  for (let i = 0; i < inRange.length; i++) {
    const row = inRange[i]!;
    const previous = inRange[i - 1];
    // 首个样本没有前驱，按 0 计入，避免把整段窗口的流量算在它头上。
    const deltaSeconds = previous ? Math.max(0, (row.timestamp - previous.timestamp) / 1000) : 0;
    up += row.net_out_speed * deltaSeconds;
    down += row.net_in_speed * deltaSeconds;
    peakUp = Math.max(peakUp, row.net_out_speed);
    peakDown = Math.max(peakDown, row.net_in_speed);
  }

  return {
    client: uuid,
    up,
    down,
    peakUp,
    peakDown,
    rangeStartMs: startMs,
    rangeEndMs: endMs,
    samples: inRange.length,
  };
}

/** 兼容旧调用点：主题设置改为本地保存，不再写回后端。 */
export function saveThemeSettings(): Promise<void> {
  return Promise.reject(
    new ApiRequestError(
      "第三方主题不能写入后端设置，请在 /admin#admin 中修改",
      403,
      "/admin#admin",
    ),
  );
}
