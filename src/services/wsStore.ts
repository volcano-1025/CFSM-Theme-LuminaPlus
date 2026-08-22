import type {
  CfsmServer,
  NodeInfo,
  NodeMetrics,
  SysConfig,
  TrafficTrendSample,
} from "@/types/cfsm";
import { getServersSnapshot } from "@/services/api";
import {
  emptyNodeMetrics,
  isServerOnline,
  mergeServerPatch,
  normalizeTimestamp,
  parseLatencyWindow,
  toNodeInfo,
  toNodeMetrics,
} from "@/services/cfsm/mappers";
import { createWsConnection, type WsConnection, type WsSample } from "@/services/cfsm/wsClient";
import {
  recordPingSample,
  retainPingNodes,
  seedPingHistory,
} from "@/services/pingLiveStore";

type Listener = () => void;

interface State {
  rawByUuid: Record<string, CfsmServer>;
  metaByUuid: Record<string, NodeInfo>;
  metricsByUuid: Record<string, NodeMetrics>;
  trafficTrends: Record<string, NodeTrafficTrend>;
  order: string[];
  failureStreak: number;
}

export interface StoreStatusSnapshot {
  failureStreak: number;
  hydrated: boolean;
  nodeInfoError: boolean;
  /** WebSocket 是否可用；false 表示当前靠轮询兜底。 */
  realtimeConnected: boolean;
  /** 多站部署下有后端未返回数据。 */
  partial: boolean;
}

export interface HomeNodeSummary {
  uuid: string;
  group: string;
  region: string;
  hidden: boolean;
  weight: number;
  online: boolean | null;
  trafficUp: number;
  trafficDown: number;
  netUp: number;
  netDown: number;
}

export interface NodeOnlineSummary {
  uuid: string;
  online: boolean | null;
}

interface TrafficTrendSeries {
  buffer: TrafficTrendSample[];
  start: number;
  size: number;
  signature: string;
  snapshot: TrafficTrendSample[];
}

interface NodeTrafficTrend {
  up: TrafficTrendSeries;
  down: TrafficTrendSeries;
  snapshot: {
    up: TrafficTrendSample[];
    down: TrafficTrendSample[];
  };
}

/** WebSocket 断开时的轮询节奏。 */
const POLL_REFRESH_INTERVAL_MS = 5_000;
/**
 * WebSocket 正常时仍定期全量对齐，用于捕获元数据变更与节点增删。
 *
 * 后端 `/api/servers` 有服务端缓存（站长口径 30 秒；实测同一份字节至少冻结 24 秒，加随机
 * query 参数也绕不过，说明缓存在 Worker 里而不是 CDN），拉得比缓存周期还密只是拿回同一份。
 */
const FULL_REFRESH_INTERVAL_MS = 60_000;
/** 离线是"超过阈值没有上报"，没有事件驱动，只能定时重算。 */
const ONLINE_RECHECK_INTERVAL_MS = 15_000;
/** 快照的瞬时速率超过这个年龄就不再当"现在"用，详见 {@link shouldTrustSnapshotRate}。 */
const SNAPSHOT_RATE_MAX_AGE_MS = 10_000;
const SERVERS_REQUEST_TIMEOUT_MS = 8_000;

/* ------------------------------------------------------------------ *
 * WebSocket 推送回放（按到达节奏匀速铺开）
 * ------------------------------------------------------------------ */
/**
 * 后端会按"有没有人在看"调整上报频率，一次推来的样本数因此不固定（实测：活跃节点约 2 秒一条，
 * 但各节点错开到达，全局看约 1 秒来一簇；慢节点会把攒下的几帧一次性补发）。
 *
 * 目标是**不论几秒推几个，看起来都匀速**。做法是一个**固定节拍器**：节拍取自实测的「到达簇间隔」
 * （相邻两簇到达的时间差，簇内几十毫秒的错开不计），每拍从各节点队列放出一帧。
 * 节拍稳定 ⇒ 观感匀速；由数据实测而来 ⇒ 后端调频率时自动跟随。
 *
 * 节奏必须按**实际到达时间**测，不能用样本自带的 ts —— 补发的历史帧 ts 相隔十几秒却同时到达，
 * 拿 ts 算会把节奏算成十几秒、越积越多（栽过一次）。每拍只取各节点最新帧、丢掉中间帧：
 * 上报快的节点若攒队列，显示值会一直滞后一拍，看起来就像它单独在乱跳。
 */
const WS_RELEASE_MIN_MS = 200;
const WS_RELEASE_MAX_MS = 3_000;
/** 还没测出到达簇间隔前的兜底（实测全局约 1 秒一簇）。 */
const WS_ARRIVAL_GAP_DEFAULT_MS = 1_000;
/** 每台节点最多排队多少帧；超了丢最老的，避免显示越拖越旧。 */
const WS_MAX_QUEUE_PER_SERVER = 8;
const WS_ARRIVAL_GAP_MAX_MS = 15_000;
/**
 * 队列里积压的帧「按当前节奏还要放多久」超过这个时长，就直接跳到最新一帧。
 *
 * 匀速回放的前提是放帧速度跟得上到达速度。标签页被后台节流、或后端一次补发一段历史时
 * 跟不上，队列会一路涨到 {@link WS_MAX_QUEUE_PER_SERVER}，此时逐帧匀速放意味着「实时带宽」
 * 显示的是十几秒前的旧值，还会把那段时间里的旧尖峰当成当前值再播一遍。
 * 内置主题的做法是按墙钟游标直接跳到最新那条（`applyPlaybackSamplesForServer`），这里对齐它：
 * 正常节奏（积压 1~2 帧）仍然匀速回放，真落后了就跳帧保新鲜。
 */
const WS_MAX_PLAYBACK_LAG_MS = 4_000;

const SCROLL_IDLE_DELAY_MS = 160;
const TRAFFIC_TREND_SAMPLE_COUNT = 18;

const EMPTY_TRAFFIC_TREND_SAMPLE: TrafficTrendSample = {
  value: 0,
  level: 0.25,
  opacity: 0.52,
};
const EMPTY_TRAFFIC_TREND_SNAPSHOT = Array.from(
  { length: TRAFFIC_TREND_SAMPLE_COUNT },
  () => EMPTY_TRAFFIC_TREND_SAMPLE,
);
const EMPTY_TRAFFIC_TREND_SERIES: TrafficTrendSeries = {
  buffer: [],
  start: 0,
  size: 0,
  signature: "",
  snapshot: EMPTY_TRAFFIC_TREND_SNAPSHOT,
};
const EMPTY_NODE_TRAFFIC_TREND_SNAPSHOT = {
  up: EMPTY_TRAFFIC_TREND_SNAPSHOT,
  down: EMPTY_TRAFFIC_TREND_SNAPSHOT,
};
const EMPTY_TRAFFIC_TREND: NodeTrafficTrend = {
  up: EMPTY_TRAFFIC_TREND_SERIES,
  down: EMPTY_TRAFFIC_TREND_SERIES,
  snapshot: EMPTY_NODE_TRAFFIC_TREND_SNAPSHOT,
};

const DEFAULT_SYS_CONFIG: SysConfig = {
  show_price: true,
  show_expire: true,
  show_tf: true,
  show_time: true,
};

function emptyState(): State {
  return {
    rawByUuid: {},
    metaByUuid: {},
    metricsByUuid: {},
    trafficTrends: {},
    order: [],
    failureStreak: 0,
  };
}

function alignEmptyMetricsTotals(metrics: NodeMetrics, info: NodeInfo): NodeMetrics {
  if (metrics.updatedAt > 0) return metrics;
  if (
    metrics.ramTotal === info.mem_total &&
    metrics.swapTotal === info.swap_total &&
    metrics.diskTotal === info.disk_total
  ) {
    return metrics;
  }

  return {
    ...metrics,
    ramTotal: info.mem_total,
    swapTotal: info.swap_total,
    diskTotal: info.disk_total,
  };
}

// 累计流量直接跟随后端计数器下降；0 视为本帧缺样，避免局部帧闪零。
export function resolveTrafficTotal(previous: number, raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : previous;
}

/**
 * 快照里的**瞬时速率**能不能用。
 *
 * `/api/servers` 有 30 秒服务端缓存，`net_in_speed` / `net_out_speed` 是被冻住的某**一个**
 * 2 秒均值样本 —— 2026-08-22 在线上取证：8 台节点的 `last_updated` 落后 29~78 秒，而它们的
 * 速率字段无一例外高于其后 28 秒的 WS 均值（1.35~10 倍，合计 1.0 MB/s 对 0.28 MB/s）。
 * 首屏照搬这份值，顶部「实时带宽」一打开就是几倍虚高，等第一帧 WS 到了再掉回来 ——
 * 站长反馈的「刚打开/刷新完页面流量数字暴涨」就是它。
 *
 * 于是只在两种情况下认这份速率：
 * ① 快照足够新（`last_updated` 在 {@link SNAPSHOT_RATE_MAX_AGE_MS} 内），值还描述得了「现在」；
 * ② WS 已经确定不可用 —— 轮询兜底时它是唯一的数据源，再旧也得用。
 * 其余情况沿用现值（首屏就是 0），等第一帧 WS 补上，实测在 WS 连上后 1 秒内到齐。
 *
 * 累计流量、在线状态不受影响：那些字段不随时间衰减，快照旧一点照样准。
 */
export function shouldTrustSnapshotRate(
  snapshotAgeMs: number,
  realtimeUnavailable: boolean,
): boolean {
  if (realtimeUnavailable) return true;
  return Number.isFinite(snapshotAgeMs) && snapshotAgeMs <= SNAPSHOT_RATE_MAX_AGE_MS;
}

/** 增量样本可能不带累计量，缺样时沿用上一帧，避免卡片闪 0。 */
function carryForwardTotals(next: NodeMetrics, previous: NodeMetrics): NodeMetrics {
  const trafficUp = resolveTrafficTotal(previous.trafficUp, next.trafficUp);
  const trafficDown = resolveTrafficTotal(previous.trafficDown, next.trafficDown);
  const trafficUpMonthly = resolveTrafficTotal(
    previous.trafficUpMonthly,
    next.trafficUpMonthly,
  );
  const trafficDownMonthly = resolveTrafficTotal(
    previous.trafficDownMonthly,
    next.trafficDownMonthly,
  );

  if (
    trafficUp === next.trafficUp &&
    trafficDown === next.trafficDown &&
    trafficUpMonthly === next.trafficUpMonthly &&
    trafficDownMonthly === next.trafficDownMonthly
  ) {
    return next;
  }
  return { ...next, trafficUp, trafficDown, trafficUpMonthly, trafficDownMonthly };
}

function shallowEqualMetrics(a: NodeMetrics, b: NodeMetrics) {
  return (
    a.online === b.online &&
    a.cpuPct === b.cpuPct &&
    a.ramUsed === b.ramUsed &&
    a.ramTotal === b.ramTotal &&
    a.ramPct === b.ramPct &&
    a.swapUsed === b.swapUsed &&
    a.swapTotal === b.swapTotal &&
    a.diskUsed === b.diskUsed &&
    a.diskTotal === b.diskTotal &&
    a.diskPct === b.diskPct &&
    a.netUp === b.netUp &&
    a.netDown === b.netDown &&
    a.trafficUp === b.trafficUp &&
    a.trafficDown === b.trafficDown &&
    a.trafficUpMonthly === b.trafficUpMonthly &&
    a.trafficDownMonthly === b.trafficDownMonthly &&
    a.uptime === b.uptime &&
    a.load1 === b.load1 &&
    a.load5 === b.load5 &&
    a.load15 === b.load15 &&
    a.process === b.process &&
    a.connectionsTcp === b.connectionsTcp &&
    a.connectionsUdp === b.connectionsUdp &&
    a.gpuPct === b.gpuPct &&
    a.gpuName === b.gpuName &&
    a.diskIo === b.diskIo &&
    a.ping === b.ping &&
    a.updatedAt === b.updatedAt
  );
}

function shallowEqualNodeInfo(a: NodeInfo, b: NodeInfo) {
  return (
    a.uuid === b.uuid &&
    a.name === b.name &&
    a.group === b.group &&
    a.region === b.region &&
    a.hidden === b.hidden &&
    a.ipv4 === b.ipv4 &&
    a.ipv6 === b.ipv6 &&
    a.cpu_name === b.cpu_name &&
    a.cpu_cores === b.cpu_cores &&
    a.arch === b.arch &&
    a.os === b.os &&
    a.kernel_version === b.kernel_version &&
    a.gpu_name === b.gpu_name &&
    a.mem_total === b.mem_total &&
    a.swap_total === b.swap_total &&
    a.disk_total === b.disk_total &&
    a.weight === b.weight &&
    a.price === b.price &&
    a.billing_cycle === b.billing_cycle &&
    a.auto_renewal === b.auto_renewal &&
    a.currency === b.currency &&
    a.expired_at === b.expired_at &&
    a.tags === b.tags &&
    a.traffic_limit === b.traffic_limit &&
    a.traffic_limit_type === b.traffic_limit_type &&
    a.traffic_reset_day === b.traffic_reset_day &&
    a.report_interval === b.report_interval &&
    a.agent_version === b.agent_version
    // updated_at 是未展示的心跳字段，不应触发整个节点列表重渲染。
  );
}

function materializeTrafficTrendSnapshot(
  buffer: TrafficTrendSample[],
  start: number,
  size: number,
) {
  if (size <= 0) return EMPTY_TRAFFIC_TREND_SNAPSHOT;

  const snapshot = new Array<TrafficTrendSample>(TRAFFIC_TREND_SAMPLE_COUNT);
  const padding = TRAFFIC_TREND_SAMPLE_COUNT - size;

  for (let i = 0; i < padding; i++) {
    snapshot[i] = EMPTY_TRAFFIC_TREND_SAMPLE;
  }

  for (let i = 0; i < size; i++) {
    snapshot[padding + i] = buffer[(start + i) % TRAFFIC_TREND_SAMPLE_COUNT]!;
  }

  return snapshot;
}

function updateTrafficTrendSeries(
  prevSeries: TrafficTrendSeries,
  value: number,
  updatedAt: number,
  online: boolean | null,
) {
  if (online === false) {
    if (!prevSeries.signature && prevSeries.size === 0) {
      return { series: prevSeries, changed: false };
    }
    return { series: EMPTY_TRAFFIC_TREND_SERIES, changed: true };
  }

  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  const signature = `${updatedAt || 0}:${safeValue}`;
  if (signature === prevSeries.signature) {
    return { series: prevSeries, changed: false };
  }

  let visibleMax = safeValue > 0 ? safeValue : 1;
  for (let i = 0; i < prevSeries.size; i++) {
    const sample = prevSeries.buffer[(prevSeries.start + i) % TRAFFIC_TREND_SAMPLE_COUNT];
    if (sample && sample.value > visibleMax) {
      visibleMax = sample.value;
    }
  }

  const level = safeValue > 0 ? Math.max(0.2, Math.min(1, safeValue / visibleMax)) : 0.25;
  const nextSample: TrafficTrendSample = {
    value: safeValue,
    level,
    opacity: safeValue > 0 ? 0.4 + level * 0.48 : 0.52,
  };

  const buffer = new Array<TrafficTrendSample>(TRAFFIC_TREND_SAMPLE_COUNT);
  const nextSize =
    prevSeries.size < TRAFFIC_TREND_SAMPLE_COUNT
      ? prevSeries.size + 1
      : TRAFFIC_TREND_SAMPLE_COUNT;
  const nextStart =
    prevSeries.size < TRAFFIC_TREND_SAMPLE_COUNT
      ? prevSeries.start
      : (prevSeries.start + 1) % TRAFFIC_TREND_SAMPLE_COUNT;
  const insertIndex =
    prevSeries.size < TRAFFIC_TREND_SAMPLE_COUNT
      ? (prevSeries.start + prevSeries.size) % TRAFFIC_TREND_SAMPLE_COUNT
      : prevSeries.start;

  if (prevSeries.size > 0) {
    for (let i = 0; i < prevSeries.size; i++) {
      buffer[(prevSeries.start + i) % TRAFFIC_TREND_SAMPLE_COUNT] =
        prevSeries.buffer[(prevSeries.start + i) % TRAFFIC_TREND_SAMPLE_COUNT]!;
    }
  }
  buffer[insertIndex] = nextSample;

  return {
    series: {
      buffer,
      start: nextStart,
      size: nextSize,
      signature,
      snapshot: materializeTrafficTrendSnapshot(buffer, nextStart, nextSize),
    },
    changed: true,
  };
}

let state: State = emptyState();
const visibleNodeListeners = new Set<Listener>();
const allNodesListeners = new Set<Listener>();
const homeNodeSummaryListeners = new Set<Listener>();
const nodeOnlineSummaryListeners = new Set<Listener>();
const storeStatusListeners = new Set<Listener>();
const sysConfigListeners = new Set<Listener>();
const nodeMetaListeners = new Map<string, Set<Listener>>();
const nodeMetricsListeners = new Map<string, Set<Listener>>();
const trafficTrendListeners = new Map<string, Set<Listener>>();
let storeVersion = 0;
let visibleNodeUuidsSnapshot: string[] = [];
let visibleNodeUuidsSnapshotVersion = -1;
let visibleNodeUuidsWithHiddenSnapshot: string[] = [];
let visibleNodeUuidsWithHiddenSnapshotVersion = -1;
let allNodeMetaSnapshot: NodeInfo[] = [];
let allNodeMetaSnapshotVersion = -1;
let homeNodeSummariesSnapshot: HomeNodeSummary[] = [];
let homeNodeSummariesSnapshotVersion = -1;
let nodeOnlineSummariesSnapshot: NodeOnlineSummary[] = [];
let nodeOnlineSummariesSnapshotVersion = -1;
let nodeOnlineSummariesVersion = 0;
let sysConfigSnapshot: SysConfig = DEFAULT_SYS_CONFIG;
let storeStatusSnapshot: StoreStatusSnapshot = {
  failureStreak: 0,
  hydrated: false,
  nodeInfoError: false,
  realtimeConnected: false,
  partial: false,
};
let scrollIdleTimer: number | null = null;
let scrollTrackingStarted = false;
let scrollActive = false;
let refreshDeferredWhileScrolling = false;

interface CommitTouches {
  meta?: Iterable<string>;
  metrics?: Iterable<string>;
  trafficTrends?: Iterable<string>;
  nodeList?: boolean;
  allNodes?: boolean;
  storeStatus?: boolean;
}

function emitListeners(listeners: Iterable<Listener>) {
  for (const listener of listeners) listener();
}

function emitMappedListeners(
  listenersByKey: Map<string, Set<Listener>>,
  keys: Iterable<string>,
) {
  for (const key of keys) {
    const listeners = listenersByKey.get(key);
    if (listeners) emitListeners(listeners);
  }
}

function hasAny(items: Iterable<string> | undefined): boolean {
  if (!items) return false;
  return !items[Symbol.iterator]().next().done;
}

function commit(next: State, touches: CommitTouches = {}) {
  const previous = state;
  const onlineTouched =
    Boolean(touches.nodeList) ||
    (touches.metrics
      ? Array.from(touches.metrics).some(
          (uuid) =>
            (previous.metricsByUuid[uuid]?.online ?? null) !==
            (next.metricsByUuid[uuid]?.online ?? null),
        )
      : false);
  state = next;
  // 派生快照以 storeVersion 作缓存键。
  storeVersion += 1;
  // 空集合也是 truthy，需检查内容才能避免误广播。
  const homeTouched =
    Boolean(touches.nodeList || touches.allNodes) ||
    hasAny(touches.meta) ||
    hasAny(touches.metrics);

  if (touches.nodeList) emitListeners(visibleNodeListeners);
  if (touches.allNodes) emitListeners(allNodesListeners);
  if (homeTouched) emitListeners(homeNodeSummaryListeners);
  if (onlineTouched) {
    nodeOnlineSummariesVersion += 1;
    emitListeners(nodeOnlineSummaryListeners);
  }
  if (touches.storeStatus) emitListeners(storeStatusListeners);
  if (touches.meta) {
    emitMappedListeners(nodeMetaListeners, touches.meta);
  }
  if (touches.metrics) {
    emitMappedListeners(nodeMetricsListeners, touches.metrics);
  }
  if (touches.trafficTrends) emitMappedListeners(trafficTrendListeners, touches.trafficTrends);
}

function markScrollActivity() {
  scrollActive = true;
  if (scrollIdleTimer != null) {
    window.clearTimeout(scrollIdleTimer);
  }
  scrollIdleTimer = window.setTimeout(() => {
    scrollIdleTimer = null;
    scrollActive = false;
    if (refreshDeferredWhileScrolling) {
      refreshDeferredWhileScrolling = false;
      void syncServers();
    }
  }, SCROLL_IDLE_DELAY_MS);
}

function ensureScrollTrackingStarted() {
  if (scrollTrackingStarted) return;
  scrollTrackingStarted = true;
  window.addEventListener("scroll", markScrollActivity, { passive: true });
}

/**
 * 用最新的原始服务器状态重算展示模型并提交。
 * `changedUuids` 为空表示全量重算（列表刷新），否则只处理受影响的节点。
 */
function applyRawUpdates(
  nextRawByUuid: Record<string, CfsmServer>,
  changedUuids: Iterable<string>,
  now = Date.now(),
) {
  const touchedMetrics = new Set<string>();
  const touchedTrafficTrends = new Set<string>();
  let nextMetricsByUuid = state.metricsByUuid;
  let nextTrafficTrends = state.trafficTrends;

  for (const uuid of changedUuids) {
    const raw = nextRawByUuid[uuid];
    const previous = state.metricsByUuid[uuid];
    if (!raw || !previous) continue;

    const merged = carryForwardTotals(toNodeMetrics(raw, now, previous), previous);
    // 首页延迟条按上报滚动累积，不再查历史接口。
    recordPingSample(uuid, merged.updatedAt, merged.ping);

    if (!shallowEqualMetrics(previous, merged)) {
      if (nextMetricsByUuid === state.metricsByUuid) {
        nextMetricsByUuid = { ...state.metricsByUuid };
      }
      nextMetricsByUuid[uuid] = merged;
      touchedMetrics.add(uuid);
    }

    const prevTrend = state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND;
    const nextUp = updateTrafficTrendSeries(
      prevTrend.up,
      merged.netUp,
      merged.updatedAt,
      merged.online,
    );
    const nextDown = updateTrafficTrendSeries(
      prevTrend.down,
      merged.netDown,
      merged.updatedAt,
      merged.online,
    );

    if (nextUp.changed || nextDown.changed) {
      if (nextTrafficTrends === state.trafficTrends) {
        nextTrafficTrends = { ...state.trafficTrends };
      }
      nextTrafficTrends[uuid] = {
        up: nextUp.series,
        down: nextDown.series,
        snapshot: {
          up: nextUp.series.snapshot,
          down: nextDown.series.snapshot,
        },
      };
      touchedTrafficTrends.add(uuid);
    }
  }

  return {
    nextMetricsByUuid,
    nextTrafficTrends,
    touchedMetrics: [...touchedMetrics],
    touchedTrafficTrends: [...touchedTrafficTrends],
  };
}

let hydrated = false;
let nodeInfoError = false;
let realtimeConnected = false;
let partialSites = false;
let syncPromise: Promise<void> | null = null;
let syncController: AbortController | null = null;

function sortServers(servers: CfsmServer[]) {
  return [...servers].sort((left, right) => left.sort_order - right.sort_order);
}

/**
 * WS 是否**已经确定**不可用：建过连接但一条都没连上。
 *
 * 首屏（还没建连，`connectionsByBase` 是空的）返回 false —— 那时该等 WS，不是拿快照的
 * 陈旧速率顶上；只有真的连不上、靠 5 秒轮询兜底时，快照才是唯一的数据源。
 */
function realtimeKnownUnavailable(): boolean {
  return connectionsByBase.size > 0 && connectedBases.size === 0;
}

function syncServers() {
  syncPromise ??= performServersSync().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

async function performServersSync() {
  if (scrollActive) {
    refreshDeferredWhileScrolling = true;
    return;
  }

  const controller = new AbortController();
  syncController = controller;
  try {
    const snapshot = await getServersSnapshot({
      signal: controller.signal,
      timeout: SERVERS_REQUEST_TIMEOUT_MS,
    });
    if (controller.signal.aborted) return;

    const now = Date.now();
    const servers = sortServers(snapshot.servers);
    const order = servers.map((server) => server.id);
    const touchedMeta = new Set<string>();
    const touchedMetrics = new Set<string>();
    const touchedTrafficTrends = new Set<string>();
    const previousUuids = new Set(state.order);
    const nextUuids = new Set(order);
    const orderChanged =
      order.length !== state.order.length ||
      order.some((uuid, index) => uuid !== state.order[index]);

    const rawByUuid: Record<string, CfsmServer> = {};
    const metaByUuid: Record<string, NodeInfo> = {};
    const metricsByUuid: Record<string, NodeMetrics> = {};
    const trafficTrends: Record<string, NodeTrafficTrend> = {};

    for (const server of servers) {
      const uuid = server.id;
      rawByUuid[uuid] = server;

      const info = toNodeInfo(server);
      const previousMeta = state.metaByUuid[uuid];
      const metaUnchanged = previousMeta != null && shallowEqualNodeInfo(previousMeta, info);
      metaByUuid[uuid] = metaUnchanged ? previousMeta : info;
      if (!metaUnchanged) touchedMeta.add(uuid);

      const previousMetrics = state.metricsByUuid[uuid];
      // 列表接口自带最新指标，可直接作为实时值使用。
      const restMetrics = carryForwardTotals(
        toNodeMetrics(server, now, previousMetrics),
        previousMetrics ?? emptyNodeMetrics(info, isServerOnline(server, now)),
      );
      // `/api/servers` 是缓存快照，`last_updated` 常比 WS 推来的样本旧十几到几十秒，而其中的
      // 瞬时速率又明显偏高（线上实测个别节点 REST 24KB/s vs WS 0.8KB/s，合计约 4 倍）。
      // 每 30 秒一次的全量刷新若照单全收，就会拿这份旧值盖掉新鲜的 WS 实时值，
      // 「实时带宽」于是每半分钟被重新抬高一次再慢慢掉回去。快照不比现值新时，
      // 只取 WS 不下发的字段（月度累计等），实时部分保持现值。
      // 采用快照时另外挡一道瞬时速率：`updatedAt` 的比较只能防住"拿旧值盖新值"，
      // 首屏没有现值可比，虚高的速率会长驱直入。
      const trustSnapshotRate = shouldTrustSnapshotRate(
        now - restMetrics.updatedAt,
        realtimeKnownUnavailable(),
      );
      const nextMetrics =
        previousMetrics && previousMetrics.updatedAt > restMetrics.updatedAt
          ? {
              ...previousMetrics,
              online: restMetrics.online,
              trafficUpMonthly: restMetrics.trafficUpMonthly,
              trafficDownMonthly: restMetrics.trafficDownMonthly,
            }
          : trustSnapshotRate
            ? restMetrics
            : {
                ...restMetrics,
                netUp: previousMetrics?.netUp ?? 0,
                netDown: previousMetrics?.netDown ?? 0,
              };
      const alignedMetrics = alignEmptyMetricsTotals(nextMetrics, info);
      if (!previousMetrics || !shallowEqualMetrics(previousMetrics, alignedMetrics)) {
        metricsByUuid[uuid] = alignedMetrics;
        touchedMetrics.add(uuid);
      } else {
        metricsByUuid[uuid] = previousMetrics;
      }

      const prevTrend = state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND;
      const metrics = metricsByUuid[uuid]!;
      // 新版后端直接给一小时窗口；旧版没有这个字段，回落到逐点累积。
      const latencyWindow = parseLatencyWindow(server);
      if (latencyWindow.length > 0) seedPingHistory(uuid, latencyWindow);
      else recordPingSample(uuid, metrics.updatedAt, metrics.ping);
      const nextUp = updateTrafficTrendSeries(
        prevTrend.up,
        metrics.netUp,
        metrics.updatedAt,
        metrics.online,
      );
      const nextDown = updateTrafficTrendSeries(
        prevTrend.down,
        metrics.netDown,
        metrics.updatedAt,
        metrics.online,
      );
      if (nextUp.changed || nextDown.changed) {
        trafficTrends[uuid] = {
          up: nextUp.series,
          down: nextDown.series,
          snapshot: { up: nextUp.series.snapshot, down: nextDown.series.snapshot },
        };
        touchedTrafficTrends.add(uuid);
      } else {
        trafficTrends[uuid] = prevTrend;
      }
    }

    for (const uuid of previousUuids) {
      if (!nextUuids.has(uuid)) {
        touchedMeta.add(uuid);
        touchedMetrics.add(uuid);
      }
    }

    const nodeListChanged =
      orderChanged ||
      [...touchedMeta].some((uuid) => {
        const prev = state.metaByUuid[uuid];
        const next = metaByUuid[uuid];
        return Boolean(prev?.hidden) !== Boolean(next?.hidden);
      });

    // 节点被删除后连带清掉它的延迟缓冲区。
    retainPingNodes(order);

    const sysConfigChanged = updateSysConfigSnapshot(snapshot.sysConfig);
    const storeStatusChanged =
      !hydrated || nodeInfoError || partialSites !== snapshot.partial;
    hydrated = true;
    nodeInfoError = false;
    partialSites = snapshot.partial;
    updateWsSubscriptions(snapshot.baseByServerId);

    if (
      orderChanged ||
      touchedMeta.size > 0 ||
      touchedMetrics.size > 0 ||
      touchedTrafficTrends.size > 0 ||
      storeStatusChanged
    ) {
      commit(
        {
          ...state,
          order,
          rawByUuid,
          metaByUuid,
          metricsByUuid,
          trafficTrends,
          failureStreak: 0,
        },
        {
          meta: touchedMeta,
          metrics: touchedMetrics,
          trafficTrends: touchedTrafficTrends,
          nodeList: nodeListChanged,
          allNodes: orderChanged || touchedMeta.size > 0,
          storeStatus: storeStatusChanged,
        },
      );
    }
    if (sysConfigChanged) emitListeners(sysConfigListeners);
  } catch (error) {
    if (!controller.signal.aborted) {
      nodeInfoError = true;
      commit({ ...state, failureStreak: state.failureStreak + 1 }, { storeStatus: true });
    }
    throw error;
  } finally {
    if (syncController === controller) syncController = null;
  }
}

/* ------------------------------------------------------------------ *
 * WebSocket 推送合流缓冲
 * ------------------------------------------------------------------ */
/** 每台节点的待放队列与它自己的出帧节奏。 */
interface PendingNode {
  queue: WsSample[];
  /** 最近若干帧的到达时刻，用来实测这台节点"平均多久出一帧"。 */
  arrivals: number[];
  /** 下一帧该在什么时刻放出（按固定间隔对齐到网格）。 */
  nextDueAt: number;
}
/** 实测出帧速率的滑动窗口长度：够长才能抹平"一次到达带来多帧"的成簇效应。 */
const WS_RATE_WINDOW = 12;
const wsPendingByServer = new Map<string, PendingNode>();
let wsTickTimer: number | null = null;
/** 细粒度轮询：到点的节点在同一拍里合成一次提交，避免每台各自触发渲染。 */
const WS_TICK_MS = 100;

/**
 * 诊断开关：URL 带 `?wsdebug=1` 时，把每次提交的节点数、以及各节点的到达节奏打到控制台。
 */
const WS_DEBUG =
  typeof location !== "undefined" && /[?&]wsdebug=1(?:&|$)/.test(location.search);
let wsDebugCommits = 0;
let wsDebugLastCommitAt = 0;

/** 供控制台随时读取当前节奏，配合 `?wsdebug=1` 使用。 */
export function getWsPlaybackStats() {
  const nodes: Record<string, { 出帧间隔: number; 待放: number }> = {};
  for (const [serverId, pending] of wsPendingByServer) {
    nodes[serverId.slice(0, 8)] = {
      出帧间隔: Math.round(resolveWsNodeIntervalMs(pending.arrivals)),
      待放: pending.queue.length,
    };
  }
  return { serverCount: state.order.length, commits: wsDebugCommits, nodes };
}

/**
 * 某节点的出帧间隔 = 它**平均多久到一帧**（用最近若干帧的到达时刻实测）。
 *
 * 目标：**这台节点上报多快就显示多快，且匀速**。关键是取「平均速率」而不是「当前队列深度」——
 * 后者会让一次到达带来多帧的节点走成 1000→2000→1000→667 的循环：队列放空后要干等一整个
 * 到达间隔，下一批又挤在一起。按平均速率定一个固定间隔，2 秒来 2 帧就恒定 1 秒一帧、
 * 10 秒来 3 帧就恒定 3.3 秒一帧，各节点各按各的，互不影响。
 *
 * `arrivals` 是升序的到达时刻；不足两个时用兜底值。
 */
export function resolveWsNodeIntervalMs(arrivals: readonly number[]): number {
  if (arrivals.length < 2) return WS_ARRIVAL_GAP_DEFAULT_MS;
  const first = arrivals[0]!;
  const span = arrivals[arrivals.length - 1]! - first;
  // 分母取「第一帧之后到达的帧数」而不是 length-1：成簇到达时同一时刻有多帧，
  // 用 length-1 会把间隔算小（12 帧跨 10 秒会得 909ms 而非 1000ms），放帧比到达快就会慢慢积压。
  let framesAfterFirst = 0;
  for (const time of arrivals) if (time > first) framesAfterFirst += 1;
  if (framesAfterFirst === 0) return WS_ARRIVAL_GAP_DEFAULT_MS;
  const interval = span / framesAfterFirst;
  if (!Number.isFinite(interval) || interval <= 0) return WS_ARRIVAL_GAP_DEFAULT_MS;
  return Math.min(WS_RELEASE_MAX_MS, Math.max(WS_RELEASE_MIN_MS, interval));
}

function scheduleWsTick(): void {
  if (wsTickTimer != null) return;
  wsTickTimer = window.setTimeout(runWsTick, WS_TICK_MS);
}

/**
 * 出帧前要丢掉多少帧陈旧的：积压按当前节奏放完要超过 {@link WS_MAX_PLAYBACK_LAG_MS} 就只留最新一帧。
 *
 * 用「还要放多久」而不是「积压几帧」判定，慢节点（出帧间隔本来就大）才不会被误判成落后。
 */
export function resolvePlaybackDropCount(queueLength: number, intervalMs: number): number {
  if (queueLength <= 1 || intervalMs <= 0) return 0;
  return queueLength * intervalMs > WS_MAX_PLAYBACK_LAG_MS ? queueLength - 1 : 0;
}

/** 一拍：把所有「到点」的节点各放一帧，合成一次提交。 */
function runWsTick(): void {
  wsTickTimer = null;
  const now = Date.now();
  const batch: WsSample[] = [];
  let pendingFrames = 0;

  for (const [serverId, pending] of wsPendingByServer) {
    if (pending.queue.length > 0 && now >= pending.nextDueAt) {
      const intervalMs = resolveWsNodeIntervalMs(pending.arrivals);
      const drop = resolvePlaybackDropCount(pending.queue.length, intervalMs);
      if (drop > 0) pending.queue.splice(0, drop);
      batch.push(pending.queue.shift()!);
      // 对齐到固定网格：从上一次应放的时刻推进一个间隔，而不是从"现在"重算，
      // 这样连续出帧的间隔恒等于该节点的平均出帧间隔。落后太多（如标签页被节流）时从现在追平。
      pending.nextDueAt = Math.max(now, pending.nextDueAt) + intervalMs;
    }
    const lastArrivalAt = pending.arrivals[pending.arrivals.length - 1] ?? 0;
    if (pending.queue.length === 0 && now - lastArrivalAt > WS_ARRIVAL_GAP_MAX_MS) {
      wsPendingByServer.delete(serverId);
      continue;
    }
    pendingFrames += pending.queue.length;
  }

  if (batch.length > 0) {
    if (WS_DEBUG) {
      const gap = wsDebugLastCommitAt > 0 ? now - wsDebugLastCommitAt : 0;
      wsDebugLastCommitAt = now;
      wsDebugCommits += 1;
      console.info(
        `[LuminaPlus WS] commit#${wsDebugCommits} 更新${batch.length}节点 · ` +
          `距上次${gap}ms · 待放${pendingFrames}帧 · 节点${wsPendingByServer.size}`,
      );
    }
    applyWsSamples(batch);
  }

  if (wsPendingByServer.size > 0) scheduleWsTick();
}

/**
 * WS 推送入口：按节点入队，并实测每台节点自己的到达节奏；
 * 由 {@link runWsTick} 按各自节奏把帧匀速放出，快的节点放得密、慢的放得疏，各自都匀速。
 */
function enqueueWsSamples(samples: WsSample[]): void {
  if (samples.length === 0) return;
  const now = Date.now();

  for (const sample of samples) {
    const serverId = sample.serverId;
    const ts = normalizeTimestamp(sample.ts);
    // 不把已显示（REST 首屏或已提交过）的节点倒回更旧的帧。
    const shownTs = normalizeTimestamp(state.rawByUuid[serverId]?.last_updated ?? 0);
    if (ts > 0 && ts <= shownTs) continue;

    let pending = wsPendingByServer.get(serverId);
    if (!pending) {
      pending = { queue: [], arrivals: [], nextDueAt: 0 };
      wsPendingByServer.set(serverId, pending);
    }

    const lastQueuedTs =
      pending.queue.length > 0
        ? normalizeTimestamp(pending.queue[pending.queue.length - 1]!.ts)
        : 0;
    if (ts > 0 && ts === lastQueuedTs) continue;
    pending.queue.push(sample);
    // 每帧都记一次到达时刻：一次到达带来多帧时它们时间相同，滑动窗口据此算出的
    // 平均间隔自然把成簇效应摊平（10 秒来 3 帧 → 平均 3.3 秒一帧）。
    pending.arrivals.push(now);
    if (pending.arrivals.length > WS_RATE_WINDOW) {
      pending.arrivals.splice(0, pending.arrivals.length - WS_RATE_WINDOW);
    }
    // 积压过多（补发一大段历史）时丢最老的，避免显示越拖越旧。
    if (pending.queue.length > WS_MAX_QUEUE_PER_SERVER) {
      pending.queue.splice(0, pending.queue.length - WS_MAX_QUEUE_PER_SERVER);
    }
    // 空闲后的第一帧立刻可放，不必等一个到达间隔。
    if (pending.nextDueAt === 0 || now > pending.nextDueAt + WS_ARRIVAL_GAP_MAX_MS) {
      pending.nextDueAt = now;
    }
  }

  if (wsPendingByServer.size > 0) scheduleWsTick();
}

function resetWsCoalesceState(): void {
  if (wsTickTimer != null) {
    window.clearTimeout(wsTickTimer);
    wsTickTimer = null;
  }
  wsPendingByServer.clear();
  wsDebugCommits = 0;
  wsDebugLastCommitAt = 0;
}

/** 实时样本落到已知节点上；未知节点等下一次全量刷新再出现。 */
function applyWsSamples(samples: WsSample[]) {
  if (samples.length === 0) return;

  const now = Date.now();
  const changed = new Set<string>();
  let nextRawByUuid = state.rawByUuid;

  for (const sample of samples) {
    const base = nextRawByUuid[sample.serverId];
    if (!base) continue;
    const merged = mergeServerPatch(base, sample.data, sample.ts);
    if (merged === base) continue;
    if (nextRawByUuid === state.rawByUuid) {
      nextRawByUuid = { ...state.rawByUuid };
    }
    nextRawByUuid[sample.serverId] = merged;
    changed.add(sample.serverId);
  }

  if (changed.size === 0) return;

  const applied = applyRawUpdates(nextRawByUuid, changed, now);
  commit(
    {
      ...state,
      rawByUuid: nextRawByUuid,
      metricsByUuid:
        applied.touchedMetrics.length > 0 ? applied.nextMetricsByUuid : state.metricsByUuid,
      trafficTrends:
        applied.touchedTrafficTrends.length > 0
          ? applied.nextTrafficTrends
          : state.trafficTrends,
    },
    {
      metrics: applied.touchedMetrics,
      trafficTrends: applied.touchedTrafficTrends,
    },
  );
}

/**
 * 掉线是"超过 5 分钟没有上报"，没有对应事件，只能定时重算在线标记。
 */
function refreshOnlineFlags() {
  if (state.order.length === 0) return;
  const now = Date.now();
  const touched: string[] = [];
  let nextMetricsByUuid = state.metricsByUuid;

  for (const uuid of state.order) {
    const raw = state.rawByUuid[uuid];
    const metrics = state.metricsByUuid[uuid];
    if (!raw || !metrics) continue;
    const online = isServerOnline(raw, now);
    if (online === metrics.online) continue;
    if (nextMetricsByUuid === state.metricsByUuid) {
      nextMetricsByUuid = { ...state.metricsByUuid };
    }
    nextMetricsByUuid[uuid] = { ...metrics, online };
    touched.push(uuid);
  }

  if (touched.length === 0) return;
  commit({ ...state, metricsByUuid: nextMetricsByUuid }, { metrics: touched });
}

function updateSysConfigSnapshot(next: SysConfig): boolean {
  const resolved: SysConfig = { ...DEFAULT_SYS_CONFIG, ...next };
  if (
    sysConfigSnapshot.show_price === resolved.show_price &&
    sysConfigSnapshot.show_expire === resolved.show_expire &&
    sysConfigSnapshot.show_tf === resolved.show_tf &&
    sysConfigSnapshot.show_time === resolved.show_time &&
    sysConfigSnapshot.long_history_points === resolved.long_history_points
  ) {
    return false;
  }
  sysConfigSnapshot = resolved;
  return true;
}

/* ------------------------------------------------------------------ *
 * WebSocket 订阅
 * ------------------------------------------------------------------ */

const connectionsByBase = new Map<string, WsConnection>();
const connectedBases = new Set<string>();

function setRealtimeConnected(next: boolean) {
  if (realtimeConnected === next) return;
  realtimeConnected = next;
  commit(state, { storeStatus: true });
}

function updateWsSubscriptions(baseByServerId: Map<string, string>) {
  const idsByBase = new Map<string, string[]>();
  for (const [serverId, base] of baseByServerId) {
    const ids = idsByBase.get(base) ?? [];
    ids.push(serverId);
    idsByBase.set(base, ids);
  }

  // 每个后端只订阅属于自己的服务器 ID。
  for (const [base, ids] of idsByBase) {
    const existing = connectionsByBase.get(base);
    if (existing) {
      existing.updateIds(ids);
      continue;
    }
    connectionsByBase.set(
      base,
      createWsConnection(base, ids, {
        onBatch: enqueueWsSamples,
        onAvailabilityChange: (available) => {
          if (available) connectedBases.add(base);
          else connectedBases.delete(base);
          setRealtimeConnected(connectedBases.size > 0);
        },
      }),
    );
  }

  for (const [base, connection] of connectionsByBase) {
    if (idsByBase.has(base)) continue;
    connection.close();
    connectionsByBase.delete(base);
    connectedBases.delete(base);
  }
  setRealtimeConnected(connectedBases.size > 0);
}

function closeAllConnections() {
  for (const connection of connectionsByBase.values()) connection.close();
  connectionsByBase.clear();
  connectedBases.clear();
  realtimeConnected = false;
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

// 连续失败时指数退避(5s→10s→…→75s)，避免后端不可用期间持续打注定失败的请求。
const BOOTSTRAP_MAX_BACKOFF_TICKS = 15;
let bootstrapBackoffTicks = 0;
let bootstrapSkipTicks = 0;

async function bootstrap() {
  try {
    await syncServers();
    bootstrapBackoffTicks = 0;
    bootstrapSkipTicks = 0;
  } catch {
    bootstrapBackoffTicks = Math.min(
      bootstrapBackoffTicks > 0 ? bootstrapBackoffTicks * 2 : 1,
      BOOTSTRAP_MAX_BACKOFF_TICKS,
    );
    bootstrapSkipTicks = bootstrapBackoffTicks;
  }
}

let started = false;
let retainCount = 0;
let stopTimer: number | null = null;
let pollTimer: number | null = null;
let fullRefreshTimer: number | null = null;
let onlineTimer: number | null = null;
let lastFullRefreshAt = 0;

function ensureStarted() {
  if (started) return;
  started = true;

  ensureScrollTrackingStarted();
  void bootstrap();

  pollTimer = window.setInterval(() => {
    if (!hydrated) {
      if (bootstrapSkipTicks > 0) {
        bootstrapSkipTicks -= 1;
        return;
      }
      void bootstrap();
      return;
    }
    // WebSocket 正常推送时不需要轮询，交给全量刷新定时器。
    if (realtimeConnected) return;
    void syncServers().catch(() => {});
  }, POLL_REFRESH_INTERVAL_MS);

  fullRefreshTimer = window.setInterval(() => {
    if (!hydrated) return;
    const now = Date.now();
    if (now - lastFullRefreshAt < FULL_REFRESH_INTERVAL_MS) return;
    lastFullRefreshAt = now;
    void syncServers().catch(() => {});
  }, FULL_REFRESH_INTERVAL_MS);

  onlineTimer = window.setInterval(refreshOnlineFlags, ONLINE_RECHECK_INTERVAL_MS);
}

export function retainStore() {
  if (stopTimer != null) {
    window.clearTimeout(stopTimer);
    stopTimer = null;
  }
  retainCount += 1;
  ensureStarted();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainCount = Math.max(0, retainCount - 1);
    if (retainCount === 0 && stopTimer == null) {
      stopTimer = window.setTimeout(() => {
        stopTimer = null;
        if (retainCount === 0) stopStore();
      }, 0);
    }
  };
}

function stopStore() {
  if (stopTimer != null) {
    window.clearTimeout(stopTimer);
    stopTimer = null;
  }
  syncController?.abort();
  syncController = null;
  closeAllConnections();
  resetWsCoalesceState();
  for (const timer of [pollTimer, fullRefreshTimer, onlineTimer]) {
    if (timer != null) window.clearInterval(timer);
  }
  pollTimer = null;
  fullRefreshTimer = null;
  onlineTimer = null;
  if (scrollIdleTimer != null) {
    window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = null;
  }
  if (scrollTrackingStarted) {
    window.removeEventListener("scroll", markScrollActivity);
    scrollTrackingStarted = false;
  }
  scrollActive = false;
  refreshDeferredWhileScrolling = false;
  hydrated = false;
  nodeInfoError = false;
  partialSites = false;
  started = false;
  lastFullRefreshAt = 0;
  bootstrapBackoffTicks = 0;
  bootstrapSkipTicks = 0;
}

function subscribeSet(listeners: Set<Listener>, listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeVisibleNodeUuids(listener: Listener): () => void {
  return subscribeSet(visibleNodeListeners, listener);
}

export function subscribeAllNodes(listener: Listener): () => void {
  return subscribeSet(allNodesListeners, listener);
}

export function subscribeHomeNodeSummaries(listener: Listener): () => void {
  return subscribeSet(homeNodeSummaryListeners, listener);
}

export function subscribeNodeOnlineSummaries(listener: Listener): () => void {
  return subscribeSet(nodeOnlineSummaryListeners, listener);
}

export function subscribeStoreStatus(listener: Listener): () => void {
  return subscribeSet(storeStatusListeners, listener);
}

export function subscribeSysConfig(listener: Listener): () => void {
  return subscribeSet(sysConfigListeners, listener);
}

export function subscribeToNodeMeta(uuid: string, listener: Listener): () => void {
  return subscribeByKey(nodeMetaListeners, uuid, listener);
}

export function subscribeToNodeMetrics(uuid: string, listener: Listener): () => void {
  return subscribeByKey(nodeMetricsListeners, uuid, listener);
}

export function subscribeToNodeTrafficTrend(uuid: string, listener: Listener): () => void {
  return subscribeByKey(trafficTrendListeners, uuid, listener);
}

function subscribeByKey(
  listenersByKey: Map<string, Set<Listener>>,
  key: string,
  listener: Listener,
): () => void {
  let listeners = listenersByKey.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByKey.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      listenersByKey.delete(key);
    }
  };
}

export function getStoreStatusSnapshot(): StoreStatusSnapshot {
  if (
    storeStatusSnapshot.failureStreak === state.failureStreak &&
    storeStatusSnapshot.hydrated === hydrated &&
    storeStatusSnapshot.nodeInfoError === nodeInfoError &&
    storeStatusSnapshot.realtimeConnected === realtimeConnected &&
    storeStatusSnapshot.partial === partialSites
  ) {
    return storeStatusSnapshot;
  }
  storeStatusSnapshot = {
    failureStreak: state.failureStreak,
    hydrated,
    nodeInfoError,
    realtimeConnected,
    partial: partialSites,
  };
  return storeStatusSnapshot;
}

export function getSysConfigSnapshot(): SysConfig {
  return sysConfigSnapshot;
}

export function getNodeMetaSnapshot(uuid: string): NodeInfo | undefined {
  return state.metaByUuid[uuid];
}

export function getNodeMetricsSnapshot(uuid: string): NodeMetrics | undefined {
  return state.metricsByUuid[uuid];
}

/** 原始服务器对象，供需要后端原字段的页面（如详情页）使用。 */
export function getRawServerSnapshot(uuid: string): CfsmServer | undefined {
  return state.rawByUuid[uuid];
}

export function getNodeTrafficTrendSnapshot(uuid: string): {
  up: TrafficTrendSample[];
  down: TrafficTrendSample[];
} {
  const trend = state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND;
  return trend.snapshot;
}

export function getVisibleNodeUuidsSnapshot(includeHidden = false): string[] {
  if (includeHidden) {
    if (visibleNodeUuidsWithHiddenSnapshotVersion === storeVersion) {
      return visibleNodeUuidsWithHiddenSnapshot;
    }
  } else if (visibleNodeUuidsSnapshotVersion === storeVersion) {
    return visibleNodeUuidsSnapshot;
  }

  const next = state.order.filter((uuid) => {
    const node = state.metaByUuid[uuid];
    return Boolean(node) && (includeHidden || !node.hidden);
  });

  const previous = includeHidden
    ? visibleNodeUuidsWithHiddenSnapshot
    : visibleNodeUuidsSnapshot;
  const value =
    next.length === previous.length && next.every((uuid, index) => uuid === previous[index])
      ? previous
      : next;

  if (includeHidden) {
    visibleNodeUuidsWithHiddenSnapshot = value;
    visibleNodeUuidsWithHiddenSnapshotVersion = storeVersion;
  } else {
    visibleNodeUuidsSnapshot = value;
    visibleNodeUuidsSnapshotVersion = storeVersion;
  }
  return value;
}

export function getAllNodeMetaSnapshot(): NodeInfo[] {
  if (allNodeMetaSnapshotVersion === storeVersion) return allNodeMetaSnapshot;

  const next = state.order
    .map((uuid) => state.metaByUuid[uuid])
    .filter((node): node is NodeInfo => Boolean(node));

  if (
    !(
      next.length === allNodeMetaSnapshot.length &&
      next.every((node, index) => node === allNodeMetaSnapshot[index])
    )
  ) {
    allNodeMetaSnapshot = next;
  }
  allNodeMetaSnapshotVersion = storeVersion;
  return allNodeMetaSnapshot;
}

export function getHomeNodeSummariesSnapshot(): HomeNodeSummary[] {
  if (homeNodeSummariesSnapshotVersion === storeVersion) return homeNodeSummariesSnapshot;

  const next = state.order
    .map((uuid) => {
      const meta = state.metaByUuid[uuid];
      if (!meta) return null;
      const metrics = state.metricsByUuid[uuid];
      const online = metrics?.online ?? null;
      // 掉线节点的瞬时速率不清零（后端 /api/servers 掉线后仍沿用最后一个快照），
      // 但「实时带宽」总览、带宽评级与带宽排序都是当下口径：节点不再上报就按 0 计，
      // 和实时流量迷你图（updateTrafficTrendSeries 掉线即清空）保持一致，否则一台
      // 死节点会把最后一刻的带宽一直算进总量。累计流量另说，见下。
      const realtimeNetUp = online === false ? 0 : metrics?.netUp ?? 0;
      const realtimeNetDown = online === false ? 0 : metrics?.netDown ?? 0;
      return {
        uuid,
        group: String(meta.group || "").trim(),
        region: String(meta.region || "").trim(),
        hidden: meta.hidden,
        weight: meta.weight,
        online,
        // 首页总览与排序看的是"累计流量"，用探针生命周期的总量；
        // 按周期重置的配额进度另用 trafficUpMonthly / trafficDownMonthly。
        trafficUp: metrics?.trafficUp ?? 0,
        trafficDown: metrics?.trafficDown ?? 0,
        netUp: realtimeNetUp,
        netDown: realtimeNetDown,
      };
    })
    .filter((item): item is HomeNodeSummary => Boolean(item));

  if (
    next.length === homeNodeSummariesSnapshot.length &&
    next.every((item, index) => {
      const prev = homeNodeSummariesSnapshot[index];
      return (
        prev &&
        prev.uuid === item.uuid &&
        prev.group === item.group &&
        prev.region === item.region &&
        prev.hidden === item.hidden &&
        prev.weight === item.weight &&
        prev.online === item.online &&
        prev.trafficUp === item.trafficUp &&
        prev.trafficDown === item.trafficDown &&
        prev.netUp === item.netUp &&
        prev.netDown === item.netDown
      );
    })
  ) {
    homeNodeSummariesSnapshotVersion = storeVersion;
    return homeNodeSummariesSnapshot;
  }

  homeNodeSummariesSnapshot = next;
  homeNodeSummariesSnapshotVersion = storeVersion;
  return homeNodeSummariesSnapshot;
}

export function getNodeOnlineSummariesSnapshot(): NodeOnlineSummary[] {
  if (nodeOnlineSummariesSnapshotVersion === nodeOnlineSummariesVersion) {
    return nodeOnlineSummariesSnapshot;
  }

  const next = state.order
    .filter((uuid) => Boolean(state.metaByUuid[uuid]))
    .map((uuid) => ({
      uuid,
      online: state.metricsByUuid[uuid]?.online ?? null,
    }));

  if (
    !(
      next.length === nodeOnlineSummariesSnapshot.length &&
      next.every((item, index) => {
        const previous = nodeOnlineSummariesSnapshot[index];
        return previous?.uuid === item.uuid && previous.online === item.online;
      })
    )
  ) {
    nodeOnlineSummariesSnapshot = next;
  }
  nodeOnlineSummariesSnapshotVersion = nodeOnlineSummariesVersion;
  return nodeOnlineSummariesSnapshot;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopStore();
  });
}
