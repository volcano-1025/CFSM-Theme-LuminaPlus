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
/** 一个样本最多向后延续多久；超过就认为数据真的断了，让图表留空。 */
const MAX_SAMPLE_HOLD_MS = 300_000;

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
  const emptyTimes: number[] = [];
  let max = 1;
  let lastValue: number | null = null;
  // 丢包率取整段窗口的加权平均，和柱状图同源（缓冲区本身就只保留一小时）。
  // 取最后一个样本会让「6 个包丢 1 个」这种单次抖动直接顶成 16%，而柱子还是全绿。
  let lostSum = 0;
  let lossWeight = 0;

  for (const sample of samples) {
    const value = sample.ping[carrier];
    if (value == null) {
      // 这一刻确实测过、但这条线路没有值，记下来防止相邻样本把它填平。
      emptyTimes.push(sample.time);
      continue;
    }
    const sampleLoss = sample.ping[lossKey];
    out.push({
      time: sample.time,
      value,
      count: 1,
      loss: sampleLoss,
    });
    if (value > max) max = value;
    if (value >= 0) lastValue = value;
    // 后端没给丢包值时不参与平均，否则会把「不知道」显示成 0%。
    if (typeof sampleLoss === "number" || value < 0) {
      const counts = resolvePingSampleCounts({ value, count: 1, loss: sampleLoss });
      lostSum += counts.lost;
      lossWeight += counts.total;
    }
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
    emptyTimes,
    max,
    loss: lossWeight > 0 ? (lostSum / lossWeight) * 100 : null,
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

/**
 * 掉线之后的柱子怎么画。
 *
 * `offlineSince` 是节点最后一次上报的时刻（在线时传 null）。它做三件事：
 *
 * 1. 丢掉时间戳晚于它的样本。后端 `/api/servers` 的一小时窗口是「没有新数据就沿用
 *    上一个值」，节点掉线后它很可能照样按墙钟往前铺格子，不挡掉就会拿旧值填满掉线段。
 * 2. 把最后一个真实样本的延续截断在这里，不再吃 `MAX_SAMPLE_HOLD_MS` 那 5 分钟。
 * 3. 整格都在它之后的桶标成 `offline`，由卡片涂红。注意是「整格」——掉线当下那一格
 *    还压着在线数据，要等它被掉线时间填满才变红，柱子于是一格一格往左推。
 */
function resolveOfflineSince(offlineSince?: number | null): number | null {
  return typeof offlineSince === "number" &&
    Number.isFinite(offlineSince) &&
    offlineSince > 0
    ? offlineSince
    : null;
}

export function buildPingBuckets(
  ping: Pick<PingOverviewItem, "samples" | "metricIntervalMs" | "emptyTimes">,
  count?: number,
  now = Date.now(),
  offlineSince?: number | null,
): PingOverviewBucket[] {
  const offlineAt = resolveOfflineSince(offlineSince);
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

  // 一个样本代表「到下一次采样为止的这段时间」。下一次采样可能是下一个有值的样本，
  // 也可能是一个明确没有值的槽位（`emptyTimes`）—— 后者要让图表真的留空。
  // 后端一小时窗口的最新一格常常不落在 2 分钟网格上，与上一格能差 4~5 分钟；
  // 不做延续就会在最右边凭空空出一格，而且随着 now 推进时有时无。
  // 掉线之后的样本一律不认：后端窗口可能还在按墙钟往前铺格子、沿用最后一个已知值。
  const beforeOffline = (time: number) => offlineAt == null || time <= offlineAt;

  const eventTimes = [
    ...(ping.samples ?? []).map((sample) => sample.time),
    ...(ping.emptyTimes ?? []),
  ]
    .filter(beforeOffline)
    .sort((left, right) => left - right);

  const nextEventAfter = (time: number): number | undefined => {
    let low = 0;
    let high = eventTimes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (eventTimes[mid]! <= time) low = mid + 1;
      else high = mid;
    }
    return eventTimes[low];
  };

  const holdMs =
    metricIntervalMs > 0
      ? Math.min(MAX_SAMPLE_HOLD_MS, Math.max(metricIntervalMs, bucketMs) * 2)
      : 0;

  const samples = (ping.samples ?? []).filter((sample) => beforeOffline(sample.time));
  for (const [order, sample] of samples.entries()) {
    if (sample.time > now) continue;

    const coverEnd = Math.max(
      sample.time,
      Math.min(
        nextEventAfter(sample.time) ?? Number.POSITIVE_INFINITY,
        sample.time + holdMs,
        offlineAt ?? Number.POSITIVE_INFINITY,
        now,
      ),
    );
    if (coverEnd <= windowStart) continue;

    // 最老的一个样本向前补一个采样间隔：后端窗口跨度是 58 分钟、图表画的是 60 分钟，
    // 不补的话最左边那格永远差一点点数据，看起来像缺了一格。
    const coverStart =
      order === 0 ? Math.max(sample.time - metricIntervalMs, windowStart) : sample.time;

    // 覆盖区间跨过哪些 bucket 的中点，就填哪些 —— 相当于 sample-and-hold，
    // 柱宽不随节点变化，也不会因为 bucket 边界对不齐而漏格。
    let assigned = false;
    for (let index = 0; index < resolvedCount; index += 1) {
      const midpoint = windowStart + (index + 0.5) * bucketMs;
      if (midpoint >= coverStart && midpoint < coverEnd) {
        addSampleToBucket(index, sample);
        assigned = true;
      }
    }
    if (assigned) continue;

    // 覆盖区间比一个 bucket 还短（或正好错过中点）时，落到它自己所在的那格。
    const overlapStart = Math.max(coverStart, windowStart);
    const overlapEnd = Math.max(Math.min(coverEnd, now), overlapStart);
    const center = overlapStart + (overlapEnd - overlapStart) / 2;
    let bucketIndex = Math.floor((center - windowStart) / bucketMs);
    if (bucketIndex < 0) continue;
    if (bucketIndex >= resolvedCount) bucketIndex = resolvedCount - 1;
    addSampleToBucket(bucketIndex, sample);
  }

  return Array.from({ length: resolvedCount }, (_, index) => {
    const startAt = windowStart + index * bucketMs;
    const endAt = startAt + bucketMs;
    const total = totals[index];
    // 丢包率按未取整的丢失量算：后端给的是百分比，先取整再求比例只会剩 0 和 100。
    const lostExact = losts[index];
    const lost = Math.round(lostExact);
    const positiveCount = positiveCounts[index];

    return {
      index,
      value: positiveCount > 0 ? positiveSums[index] / positiveCount : null,
      loss: total > 0 ? (lostExact / total) * 100 : null,
      total,
      lost,
      startAt,
      endAt,
      // 整格都在掉线之后才算离线格。掉线当下那一格还压着在线数据，
      // 要等掉线时长把它填满才翻红，于是红色一格一格往左推。
      offline: offlineAt != null && startAt >= offlineAt,
    };
  });
}

export function usePingBuckets(
  ping: Pick<PingOverviewItem, "samples" | "metricIntervalMs" | "emptyTimes">,
  count?: number,
  enabled = true,
  offlineSince?: number | null,
): PingOverviewBucket[] {
  const { samples, metricIntervalMs, emptyTimes } = ping;
  // 数据引用不变时窗口也要随时间前移,否则时间轴最多滞后约 2 个桶;分钟粒度足够
  // (桶宽 ≥150s),也避免每次推送都重算。
  const now = useMinuteClock(enabled);
  return useMemo(
    () =>
      enabled
        ? buildPingBuckets(
            { samples, metricIntervalMs, emptyTimes },
            count,
            now,
            offlineSince,
          )
        : EMPTY_PING_BUCKETS,
    [count, emptyTimes, enabled, metricIntervalMs, now, offlineSince, samples],
  );
}
