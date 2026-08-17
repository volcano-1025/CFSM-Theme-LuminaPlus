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
/** WebSocket 正常时仍定期全量对齐，用于捕获元数据变更与节点增删。 */
const FULL_REFRESH_INTERVAL_MS = 30_000;
/** 离线是"超过阈值没有上报"，没有事件驱动，只能定时重算。 */
const ONLINE_RECHECK_INTERVAL_MS = 15_000;
const SERVERS_REQUEST_TIMEOUT_MS = 8_000;

/* ------------------------------------------------------------------ *
 * WebSocket 推送回放（按到达节奏匀速铺开）
 * ------------------------------------------------------------------ */
/**
 * 后端会按"有没有人在看"调整上报频率，一次推来的样本数因此不固定（实测：活跃节点约 2 秒一条；
 * 慢节点会把攒下的几帧一次性补发）。目标是**不论几秒推几个，看起来都匀速**：
 * 一批 N 个、每 T 毫秒来一批，就每 T/N 毫秒放一个。
 *
 * 节奏取自**实际到达时间**间隔，而不是样本自带的 ts —— 补发的历史帧 ts 相隔十几秒却同时到达，
 * 拿 ts 算会把节奏算成十几秒、越积越多（上一版正是栽在这里）。队列深度参与分母，
 * 于是积压时自动加快、追平后自动回落，不会越拖越久。
 */
const WS_RELEASE_MIN_MS = 200;
const WS_RELEASE_MAX_MS = 3_000;
/** 还没测出到达间隔前的兜底（实测活跃节点约 2 秒一条）。 */
const WS_ARRIVAL_GAP_DEFAULT_MS = 2_000;
/** 只采信这个区间内的到达间隔，滤掉重连突发与长时间静默。 */
const WS_ARRIVAL_GAP_MIN_MS = 500;
const WS_ARRIVAL_GAP_MAX_MS = 15_000;
const WS_ARRIVAL_ALPHA = 0.25;
/** 各节点是错开几十~两百毫秒到达的，用一个很短的窗口把这一簇并成一次渲染。 */
const WS_CLUSTER_WINDOW_MS = 150;
/** 每台节点最多排队多少帧；超了丢最老的，避免落后现实太久。 */
const WS_MAX_QUEUE_PER_SERVER = 8;

/**
 * 下一帧该隔多久放：到达间隔 ÷ 待放帧数。
 * `remainingDepth` 是本次放完后队列里还剩的最大深度；+1 是把"下一批到达"也算作一个槽位，
 * 这样 2 秒来 2 个时是 1 秒一个，正好在下一批到达时放完。
 */
export function resolveWsReleaseIntervalMs(
  arrivalGapMs: number,
  remainingDepth: number,
): number {
  const gap = arrivalGapMs > 0 ? arrivalGapMs : WS_ARRIVAL_GAP_DEFAULT_MS;
  const slots = Math.max(1, remainingDepth + 1);
  return Math.min(WS_RELEASE_MAX_MS, Math.max(WS_RELEASE_MIN_MS, gap / slots));
}
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
      const nextMetrics = carryForwardTotals(
        toNodeMetrics(server, now, previousMetrics),
        previousMetrics ?? emptyNodeMetrics(info, isServerOnline(server, now)),
      );
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
/** 每台节点一条按 ts 升序的待放队列。 */
const wsQueueByServer = new Map<string, WsSample[]>();
/** 每台节点上一次「到达」的墙钟时刻，用来实测到达间隔。 */
const wsLastArrivalAtByServer = new Map<string, number>();
/** 到达间隔的 EMA（毫秒）；0 = 还没测出。 */
let wsArrivalGapEmaMs = 0;
let wsReleaseTimer: number | null = null;

/**
 * 诊断开关：URL 带 `?wsdebug=1` 时，把每次放帧的节点数 / 距上次时长 / 到达间隔 / 队列深度
 * 打到控制台。本地无 WSS，只能靠线上这份输出核对。
 */
const WS_DEBUG =
  typeof location !== "undefined" && /[?&]wsdebug=1(?:&|$)/.test(location.search);
let wsDebugReleases = 0;
let wsDebugLastReleaseAt = 0;

function maxQueueDepth(): number {
  let depth = 0;
  for (const queue of wsQueueByServer.values()) {
    if (queue.length > depth) depth = queue.length;
  }
  return depth;
}

/** 供控制台随时读取当前回放状态，配合 `?wsdebug=1` 使用。 */
export function getWsPlaybackStats() {
  let queued = 0;
  for (const queue of wsQueueByServer.values()) queued += queue.length;
  return {
    arrivalGapEmaMs: Math.round(wsArrivalGapEmaMs),
    nextReleaseInMs: resolveWsReleaseIntervalMs(wsArrivalGapEmaMs, maxQueueDepth()),
    queuedSamples: queued,
    maxQueueDepth: maxQueueDepth(),
    serverCount: state.order.length,
    releases: wsDebugReleases,
  };
}

/** 每台节点放出队首一帧，合成一次提交；队列还有货就按 到达间隔÷待放数 排下一次。 */
function releaseWsSamples(): void {
  wsReleaseTimer = null;
  const batch: WsSample[] = [];
  for (const [serverId, queue] of wsQueueByServer) {
    const sample = queue.shift();
    if (sample) batch.push(sample);
    if (queue.length === 0) wsQueueByServer.delete(serverId);
  }

  const depth = maxQueueDepth();
  if (batch.length > 0) {
    if (WS_DEBUG) {
      const now = Date.now();
      const gap = wsDebugLastReleaseAt > 0 ? now - wsDebugLastReleaseAt : 0;
      wsDebugLastReleaseAt = now;
      wsDebugReleases += 1;
      console.info(
        `[LuminaPlus WS] release#${wsDebugReleases} 更新${batch.length}节点 · ` +
          `距上次${gap}ms · 到达间隔EMA ${Math.round(wsArrivalGapEmaMs)}ms · ` +
          `剩余深度${depth} · 下次${depth > 0 ? Math.round(resolveWsReleaseIntervalMs(wsArrivalGapEmaMs, depth)) : "-"}ms`,
      );
    }
    applyWsSamples(batch);
  }

  if (depth > 0) {
    wsReleaseTimer = window.setTimeout(
      releaseWsSamples,
      resolveWsReleaseIntervalMs(wsArrivalGapEmaMs, depth),
    );
  }
}

/**
 * WS 推送入口：样本按 ts 入各节点队列，由回放定时器按「到达间隔 ÷ 待放数」匀速放出。
 * 一次推来几个就在下一批到达前均匀铺完，因此不论后端怎么调上报频率，观感都是匀速。
 */
function enqueueWsSamples(samples: WsSample[]): void {
  if (samples.length === 0) return;
  const now = Date.now();
  const arrivedServers = new Set<string>();

  for (const sample of samples) {
    const serverId = sample.serverId;
    // 到达间隔按节点各自统计（同一批里同一台只记一次）。
    if (!arrivedServers.has(serverId)) {
      arrivedServers.add(serverId);
      const last = wsLastArrivalAtByServer.get(serverId);
      wsLastArrivalAtByServer.set(serverId, now);
      const gap = last != null ? now - last : 0;
      if (gap >= WS_ARRIVAL_GAP_MIN_MS && gap <= WS_ARRIVAL_GAP_MAX_MS) {
        wsArrivalGapEmaMs =
          wsArrivalGapEmaMs === 0
            ? gap
            : wsArrivalGapEmaMs * (1 - WS_ARRIVAL_ALPHA) + gap * WS_ARRIVAL_ALPHA;
      }
    }

    const ts = normalizeTimestamp(sample.ts);
    // 不把已显示（REST 首屏或已放过）的节点倒回更旧的帧。
    const shownTs = normalizeTimestamp(state.rawByUuid[serverId]?.last_updated ?? 0);
    if (ts > 0 && ts <= shownTs) continue;
    let queue = wsQueueByServer.get(serverId);
    if (!queue) {
      queue = [];
      wsQueueByServer.set(serverId, queue);
    }
    const lastQueuedTs =
      queue.length > 0 ? normalizeTimestamp(queue[queue.length - 1]!.ts) : 0;
    if (ts > 0 && ts <= lastQueuedTs) continue;
    queue.push(sample);
    if (queue.length > WS_MAX_QUEUE_PER_SERVER) {
      queue.splice(0, queue.length - WS_MAX_QUEUE_PER_SERVER);
    }
  }

  // 各节点错开几十毫秒到达，等一个很短的窗口把这一簇并成一次渲染再开始放。
  if (wsQueueByServer.size > 0 && wsReleaseTimer == null) {
    wsReleaseTimer = window.setTimeout(releaseWsSamples, WS_CLUSTER_WINDOW_MS);
  }
}

function resetWsCoalesceState(): void {
  if (wsReleaseTimer != null) {
    window.clearTimeout(wsReleaseTimer);
    wsReleaseTimer = null;
  }
  wsQueueByServer.clear();
  wsLastArrivalAtByServer.clear();
  wsArrivalGapEmaMs = 0;
  wsDebugReleases = 0;
  wsDebugLastReleaseAt = 0;
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
