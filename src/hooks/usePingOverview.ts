import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useMinuteClock } from "@/hooks/useClock";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import {
  getPingHistorySnapshot,
  subscribePingHistory,
  type PingLiveSample,
} from "@/services/pingLiveStore";
import { CARRIER_TASK_BY_ID, inferIntervalSeconds } from "@/services/cfsm/mappers";
import type {
  CarrierKey,
  HomepagePingLine,
  PingOverviewBucket,
  PingOverviewItem,
} from "@/types/cfsm";
import { resolvePingSampleCounts } from "@/utils/pingMetrics";
import {
  DEFAULT_HOMEPAGE_PING_TASK_ID,
  HOMEPAGE_MULTI_PING_TASK_COUNT,
  invertHomepagePingTaskBindings,
} from "@/utils/pingTasks";
import type { NodeViewMode } from "@/utils/themeSettings";

/**
 * 首页延迟数据。
 *
 * 数据来自 `@/services/pingLiveStore` 的实时缓冲区（由 `/api/servers` 与 WebSocket 推送
 * 累积），不查历史接口 —— 逐节点查 `/api/history/all` 会让后端 D1 读行翻几十倍。
 * 实例详情页的 Ping 图表仍然读历史，那是用户主动打开、单节点一次的请求。
 */

// 首页延迟图表最多显示 24 个 bucket。
const MAX_VISIBLE_HOMEPAGE_PING_BUCKETS = 24;
/** 样本间隔推不出来时的兜底，用于把样本投影到 bucket。 */
const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
/** 后端窗口是 2 分钟一个槽位，本地累积约 50 秒一个；限制在这个区间内。 */
const MIN_SAMPLE_INTERVAL_MS = 20_000;
const MAX_SAMPLE_INTERVAL_MS = 300_000;

/**
 * 样本间隔由数据自己决定：后端一小时窗口是 120 秒一个点，本地累积约 50 秒一个。
 * 写死一个值会让其中一种来源的柱子落位偏移。
 */
function resolveSampleIntervalMs(samples: readonly PingLiveSample[]): number {
  const seconds = inferIntervalSeconds(samples.map((sample) => sample.time));
  if (!seconds) return DEFAULT_SAMPLE_INTERVAL_MS;
  return Math.min(
    MAX_SAMPLE_INTERVAL_MS,
    Math.max(MIN_SAMPLE_INTERVAL_MS, seconds * 1000),
  );
}

const EMPTY_PING: PingOverviewItem = {
  client: "",
  isAssigned: false,
  loadState: "ready",
  lastValue: null,
  samples: [],
  max: 1,
  loss: null,
};
const EMPTY_PING_LINES: HomepagePingLine[] = [];
const EMPTY_PING_BUCKETS: PingOverviewBucket[] = [];
const EMPTY_SAMPLES: readonly PingLiveSample[] = [];

type HomepagePingRequestMode = "single" | "multi";

export function resolveHomepagePingRequestMode(
  viewMode: NodeViewMode,
  multiPingEnabled: boolean,
  multiTaskIds: number[],
): HomepagePingRequestMode {
  return (viewMode === "large" || viewMode === "compact") &&
    multiPingEnabled &&
    multiTaskIds.length === HOMEPAGE_MULTI_PING_TASK_COUNT
    ? "multi"
    : "single";
}

const LOSS_KEY_BY_CARRIER: Record<CarrierKey, keyof PingLiveSample["ping"]> = {
  ct: "lossCt",
  cu: "lossCu",
  cm: "lossCm",
  bd: "lossBd",
};

/**
 * 把缓冲区里的样本转成某条线路的展示模型。
 *
 * 返回值按 (samples, taskId) 缓存，`useSyncExternalStore` 要求 getSnapshot 引用稳定。
 */
const itemCache = new WeakMap<object, Map<number, PingOverviewItem>>();

export function buildPingOverviewItem(
  client: string,
  taskId: number,
  samples: readonly PingLiveSample[],
  sampleIntervalMs?: number,
): PingOverviewItem {
  const task = CARRIER_TASK_BY_ID.get(taskId);
  if (!task || samples.length === 0) {
    return { ...EMPTY_PING, client };
  }

  const carrier = task.key;
  const lossKey = LOSS_KEY_BY_CARRIER[carrier];
  const out: PingOverviewItem["samples"] = [];
  let max = 1;
  let lastValue: number | null = null;
  let loss: number | null = null;

  for (const sample of samples) {
    const value = sample.ping[carrier];
    if (value == null) continue;
    const sampleLoss = sample.ping[lossKey];
    out.push({
      time: sample.time,
      value,
      count: 1,
      loss: sampleLoss,
    });
    if (value > max) max = value;
    if (value >= 0) lastValue = value;
    if (typeof sampleLoss === "number") loss = sampleLoss;
  }

  return {
    // 该线路没有任何实测值时不算"已分配"：卡片不画空柱子，
    // 也让"模拟延迟"设置有机会接管。
    client,
    isAssigned: out.length > 0,
    loadState: "ready",
    lastValue,
    metricIntervalMs: sampleIntervalMs ?? resolveSampleIntervalMs(samples),
    samples: out,
    max,
    loss,
  };
}

function getCachedItem(
  client: string,
  taskId: number,
  samples: readonly PingLiveSample[],
  sampleIntervalMs?: number,
): PingOverviewItem {
  if (samples.length === 0) {
    return buildPingOverviewItem(client, taskId, samples, sampleIntervalMs);
  }
  let byTask = itemCache.get(samples);
  if (!byTask) {
    byTask = new Map();
    itemCache.set(samples, byTask);
  }
  const cached = byTask.get(taskId);
  if (cached) return cached;

  const item = buildPingOverviewItem(client, taskId, samples, sampleIntervalMs);
  byTask.set(taskId, item);
  return item;
}

const lineCache = new WeakMap<object, Map<string, HomepagePingLine[]>>();

function getCachedLines(
  client: string,
  taskIds: number[],
  samples: readonly PingLiveSample[],
  sampleIntervalMs?: number,
): HomepagePingLine[] {
  if (taskIds.length === 0) return EMPTY_PING_LINES;
  const key = taskIds.join(",");
  if (samples.length === 0) {
    return taskIds.map((taskId) => ({
      ...buildPingOverviewItem(client, taskId, samples, sampleIntervalMs),
      taskId,
      taskName: CARRIER_TASK_BY_ID.get(taskId)?.name ?? `线路 #${taskId}`,
    }));
  }

  let byKey = lineCache.get(samples);
  if (!byKey) {
    byKey = new Map();
    lineCache.set(samples, byKey);
  }
  const cached = byKey.get(key);
  if (cached) return cached;

  const lines = taskIds.map((taskId) => ({
    ...getCachedItem(client, taskId, samples, sampleIntervalMs),
    taskId,
    taskName: CARRIER_TASK_BY_ID.get(taskId)?.name ?? `线路 #${taskId}`,
  }));
  byKey.set(key, lines);
  return lines;
}

function usePingSamples(uuid: string, enabled: boolean): readonly PingLiveSample[] {
  const subscribe = useCallback(
    (callback: () => void) =>
      uuid && enabled ? subscribePingHistory(uuid, callback) : () => undefined,
    [enabled, uuid],
  );
  const getSnapshot = useCallback(
    () => (uuid && enabled ? getPingHistorySnapshot(uuid) : EMPTY_SAMPLES),
    [enabled, uuid],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 节点在单线路模式下显示哪条线路：设置里指定过就用指定的，否则默认电信。 */
function useSelectedTaskId(uuid: string): number {
  const { homepagePingBindings } = useThemeSettings();
  return useMemo(() => {
    const byClient = invertHomepagePingTaskBindings(homepagePingBindings);
    return byClient.get(uuid) ?? DEFAULT_HOMEPAGE_PING_TASK_ID;
  }, [homepagePingBindings, uuid]);
}

/**
 * 保留给首页网格调用。实时累积不需要轮询，这里只是接口占位，
 * 让调用方不必区分数据来源。
 */
export function useHomepagePingOverview(_viewMode: NodeViewMode): void {
  void _viewMode;
}

export function useNodePingOverview(uuid: string, enabled = true): PingOverviewItem {
  const samples = usePingSamples(uuid, enabled);
  const taskId = useSelectedTaskId(uuid);
  return useMemo(
    () =>
      enabled
        ? getCachedItem(uuid, taskId, samples)
        : EMPTY_PING,
    [enabled, samples, taskId, uuid],
  );
}

export function useNodePingOverviewLines(
  uuid: string,
  enabled = true,
): HomepagePingLine[] {
  const samples = usePingSamples(uuid, enabled);
  const { homepageMultiPingTaskIds } = useThemeSettings();
  return useMemo(
    () =>
      enabled
        ? getCachedLines(uuid, homepageMultiPingTaskIds, samples)
        : EMPTY_PING_LINES,
    [enabled, homepageMultiPingTaskIds, samples, uuid],
  );
}

export function buildPingBuckets(
  ping: Pick<PingOverviewItem, "samples" | "metricIntervalMs">,
  count?: number,
  now = Date.now(),
): PingOverviewBucket[] {
  const totalWindowMs = 60 * 60 * 1000;
  const requestedCount = count ?? MAX_VISIBLE_HOMEPAGE_PING_BUCKETS;
  const boundedRequestedCount =
    Number.isFinite(requestedCount) && requestedCount > 0
      ? Math.min(240, Math.max(1, Math.round(requestedCount)))
      : MAX_VISIBLE_HOMEPAGE_PING_BUCKETS;
  const metricIntervalMs =
    typeof ping.metricIntervalMs === "number" &&
    Number.isFinite(ping.metricIntervalMs) &&
    ping.metricIntervalMs > 0
      ? ping.metricIntervalMs
      : 0;
  const resolvedCount = boundedRequestedCount;
  const bucketMs = totalWindowMs / resolvedCount;
  const windowStart = now - totalWindowMs;
  const totals = new Array<number>(resolvedCount).fill(0);
  const losts = new Array<number>(resolvedCount).fill(0);
  const positiveSums = new Array<number>(resolvedCount).fill(0);
  const positiveCounts = new Array<number>(resolvedCount).fill(0);

  const addSampleToBucket = (
    bucketIndex: number,
    sample: PingOverviewItem["samples"][number],
  ) => {
    const { total: sampleCount, lost: sampleLost, valid: sampleValid } =
      resolvePingSampleCounts(sample);

    totals[bucketIndex] += sampleCount;
    losts[bucketIndex] += sampleLost;
    if (sample.value >= 0 && sampleValid > 0) {
      positiveSums[bucketIndex] += sample.value * sampleValid;
      positiveCounts[bucketIndex] += sampleValid;
    }
  };

  for (const sample of ping.samples ?? []) {
    if (metricIntervalMs > bucketMs) {
      const sampleEnd = sample.time + metricIntervalMs;
      if (sampleEnd <= windowStart || sample.time > now) continue;

      // 样本时间戳是采样点起点。以每个可视 bucket 的中点判断它落在哪个采样区间，
      // 相当于 sample-and-hold：不会制造规律性空洞，也不会让柱宽随节点变化。
      for (let index = 0; index < resolvedCount; index += 1) {
        const midpoint = windowStart + (index + 0.5) * bucketMs;
        if (midpoint >= sample.time && midpoint < sampleEnd) {
          addSampleToBucket(index, sample);
        }
      }
      continue;
    }

    let sampleTime = sample.time;
    if (metricIntervalMs > 0) {
      const sampleEnd = sample.time + metricIntervalMs;
      if (sampleEnd <= windowStart || sample.time > now) continue;
      const overlapStart = Math.max(sample.time, windowStart);
      const overlapEnd = Math.min(sampleEnd, now);
      if (overlapEnd < overlapStart) continue;
      sampleTime = overlapStart + (overlapEnd - overlapStart) / 2;
    } else if (sample.time < windowStart || sample.time > now) {
      continue;
    }

    let bucketIndex = Math.floor((sampleTime - windowStart) / bucketMs);
    if (bucketIndex < 0) continue;
    if (bucketIndex >= resolvedCount) bucketIndex = resolvedCount - 1;
    addSampleToBucket(bucketIndex, sample);
  }

  return Array.from({ length: resolvedCount }, (_, index) => {
    const startAt = windowStart + index * bucketMs;
    const endAt = startAt + bucketMs;
    const total = totals[index];
    const lost = Math.round(losts[index]);
    const positiveCount = positiveCounts[index];

    return {
      index,
      value: positiveCount > 0 ? positiveSums[index] / positiveCount : null,
      loss: total > 0 ? (lost / total) * 100 : null,
      total,
      lost,
      startAt,
      endAt,
    };
  });
}

export function usePingBuckets(
  ping: Pick<PingOverviewItem, "samples" | "metricIntervalMs">,
  count?: number,
  enabled = true,
): PingOverviewBucket[] {
  const { samples, metricIntervalMs } = ping;
  // 数据引用不变时窗口也要随时间前移,否则时间轴最多滞后约 2 个桶;分钟粒度足够
  // (桶宽 ≥150s),也避免每次推送都重算。
  const now = useMinuteClock(enabled);
  return useMemo(
    () =>
      enabled
        ? buildPingBuckets({ samples, metricIntervalMs }, count, now)
        : EMPTY_PING_BUCKETS,
    [count, enabled, metricIntervalMs, now, samples],
  );
}
