import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useMinuteClock } from "@/hooks/useClock";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import {
  getPingHistorySnapshot,
  subscribePingHistory,
  PING_WINDOW_MS,
  SAMPLE_TTL_MS,
  type PingLiveSample,
} from "@/services/pingLiveStore";
import { CARRIER_TASK_BY_ID, inferIntervalSeconds } from "@/services/cfsm/mappers";
import type {
  CarrierKey,
  CarrierPingSnapshot,
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

// 首页延迟图表显示 20 个 bucket：与后端窗口的 20 个槽位一一对应，一格正好一个后端采样点，
// 不因为除不尽而把相邻槽位混进同一格。后端返回 20 条这个数没变（2026-08-24 起把窗口跨度从
// 1 小时拉到 2 小时，只是每格代表的时长从 3 分钟变 6 分钟，格数照旧）。
// **四种视图（大卡/小卡/迷你卡/列表）统一用这个数**，别再各挑各的格数 —— 格数一旦
// 和后端槽位对不上，同一台节点在不同视图里的柱子就会错位。
export const HOMEPAGE_PING_BUCKET_COUNT = 20;
/**
 * 柱状图跨度的下限。窗口跨度不写死、跟着后端数据的时间范围走（见 {@link buildPingBuckets}），
 * 但一台刚加进来只有几分钟数据的节点不该被画成几格宽 —— 低于这个下限就按下限画，多出来的
 * 左侧照旧留空（和从前一小时固定窗口时「数据没铺满就左边空」是一个观感）。
 */
const MIN_PING_WINDOW_MS = 30 * 60 * 1000;
/** 柱状图跨度的上限：与缓冲区保留期对齐，能到手的最老样本本就不会比它更旧。 */
const MAX_PING_WINDOW_MS = SAMPLE_TTL_MS;
/** 样本间隔推不出来时的兜底，用于把样本投影到 bucket。 */
const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
/** 后端窗口是 2 分钟一个槽位，本地实测最密时探测间隔（约 60 秒）一个；限制在这个区间内。 */
const MIN_SAMPLE_INTERVAL_MS = 20_000;
const MAX_SAMPLE_INTERVAL_MS = 300_000;
/**
 * 一个样本最多向后延续多久的**下限**：超过就认为数据真的断了，让图表留空。
 *
 * 实际上限还要跟着格宽走（见 {@link buildPingBuckets} 里的 `holdCapMs`）：窗口拉到 2 小时后
 * 一格约 6 分钟，若上限死守 5 分钟就短于后端相邻两点的间距，会把本该相连的点断开、每格之间
 * 空一条缝。所以取「两格」和这个下限里的大者。
 */
const MAX_SAMPLE_HOLD_MS = 300_000;

/**
 * 样本间隔由数据自己决定：后端一小时窗口是 120 秒一个点，本地实测跟着探测节奏走（约 60 秒）。
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
      // 权重由合并时定：后端窗口的点比本地样本疏几倍，要抵几份，否则丢包的加权平均
      // 会往密的那一段偏（见 pingLiveStore 的 mergeWindowWithLocal）。
      count: sample.weight ?? 1,
      loss: sampleLoss,
    });
    if (value > max) max = value;
    if (value >= 0) lastValue = value;
    // 后端没给丢包值时不参与平均，否则会把「不知道」显示成 0%。
    if (typeof sampleLoss === "number" || value < 0) {
      // 权重同上：两个来源疏密不同，按条数平均会偏向密的那一段。
      const counts = resolvePingSampleCounts({
        value,
        count: sample.weight ?? 1,
        loss: sampleLoss,
      });
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

/**
 * 柱子按后端窗口画（口径与 `/api/servers` 一致），但旁边那个「当前延迟」数字仍取 WS 的实时值。
 *
 * 窗口末点最多滞后一格（2 分钟），快照本身还比 WS 旧十几到几十秒 —— 只看数字会觉得卡住不动。
 * 丢包率不这么办：它是整段窗口的加权平均，取最后一次采样会把「6 个包丢 1 个」直接顶成 16%，
 * 而柱子还是全绿。
 */
export function withLiveLatency(
  item: PingOverviewItem,
  live: CarrierPingSnapshot | null,
  taskId: number,
): PingOverviewItem {
  if (!live || !item.isAssigned) return item;
  const carrier = CARRIER_TASK_BY_ID.get(taskId)?.key;
  if (!carrier) return item;
  const value = live[carrier];
  // 负值是「这次探测失败」，不是延迟；缺值同理，都保持窗口给的那个数。
  if (value == null || value < 0 || value === item.lastValue) return item;
  return { ...item, lastValue: value };
}

/** 节点在单线路模式下显示哪条线路：设置里指定过就用指定的，否则默认电信。 */
export function useSelectedTaskId(uuid: string): number {
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

/**
 * 柱状图画多宽：不写死时间区，直接由数据自己的时间范围决定 —— 最老的一个事件（样本或空槽）到
 * `now`。后端把窗口从 1 小时调到 2 小时、或以后再调，一格仍旧对着一个后端采样点，前端不用改
 * 常量（后端作者的原话：前端不写死时间区，自动取 api 返回的内容）。夹在
 * [{@link MIN_PING_WINDOW_MS}, {@link MAX_PING_WINDOW_MS}] 之间：太短会把「刚加进来只有几分钟
 * 数据」的节点画成几格宽（下限内左侧照旧留空）；太长（TTL 边缘的孤立样本）会把柱子压扁。
 * 一个数据都没有时退回 {@link PING_WINDOW_MS} 基准（此时全是空格，跨度多少无所谓）。
 * `override` 由调用方显式给定时优先（单测用来钉死跨度）。
 */
function resolvePingWindowMs(
  ping: Pick<PingOverviewItem, "samples" | "emptyTimes">,
  offlineAt: number | null,
  now: number,
  override?: number,
): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.min(MAX_PING_WINDOW_MS, Math.max(MIN_PING_WINDOW_MS, override));
  }
  let oldest = Number.POSITIVE_INFINITY;
  const consider = (time: number) => {
    if (
      Number.isFinite(time) &&
      time > 0 &&
      time <= now &&
      (offlineAt == null || time <= offlineAt) &&
      time < oldest
    ) {
      oldest = time;
    }
  };
  for (const sample of ping.samples ?? []) consider(sample.time);
  for (const time of ping.emptyTimes ?? []) consider(time);
  if (!Number.isFinite(oldest)) return PING_WINDOW_MS;
  return Math.min(MAX_PING_WINDOW_MS, Math.max(MIN_PING_WINDOW_MS, now - oldest));
}

export function buildPingBuckets(
  ping: Pick<PingOverviewItem, "samples" | "metricIntervalMs" | "emptyTimes">,
  count?: number,
  now = Date.now(),
  offlineSince?: number | null,
  windowMs?: number,
): PingOverviewBucket[] {
  const offlineAt = resolveOfflineSince(offlineSince);
  const totalWindowMs = resolvePingWindowMs(ping, offlineAt, now, windowMs);
  const requestedCount = count ?? HOMEPAGE_PING_BUCKET_COUNT;
  const boundedRequestedCount =
    Number.isFinite(requestedCount) && requestedCount > 0
      ? Math.min(240, Math.max(1, Math.round(requestedCount)))
      : HOMEPAGE_PING_BUCKET_COUNT;
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
  // 后端窗口的最新一格常常不落在网格上，与上一格能差好几分钟；
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

  // 延续上限至少给「两格」：格宽随窗口跨度变化（2 小时 20 格≈6 分钟），固定 5 分钟会短于
  // 后端相邻两点的间距，把连续的点断成一条条缝。相邻两点之间靠 `nextEventAfter` 兜住不会
  // 过填，这个上限只在「后面没有下一个点」（末点或真断档）时才起作用。
  const holdCapMs = Math.max(MAX_SAMPLE_HOLD_MS, bucketMs * 2);
  const holdMs =
    metricIntervalMs > 0
      ? Math.min(holdCapMs, Math.max(metricIntervalMs, bucketMs) * 2)
      : 0;

  /**
   * 最老的那个样本要向前补多久。
   *
   * 跨度改成跟着数据走之后，最老样本通常正好落在 `windowStart`，向前补基本是空操作；这段仍留着
   * 兜两种情形：① 数据跨度不足下限、按 {@link MIN_PING_WINDOW_MS} 撑开时，最老样本在 windowStart
   * 之后，第一格会缺一点；② 最老的事件是个空槽（`emptyTimes`）、比最老的有值样本还早。
   * 补的量取**这个样本自己**到下一个事件的实际间隔，不用全局中位数 `metricIntervalMs`：缓冲区里
   * 混着本地实测（约 60 秒一个），中位数会被拉低，补不够左边那格就时空时不空。上限同
   * {@link holdMs}，免得孤立样本把左边整段涂满。
   */
  const leadingHoldMs = (time: number): number => {
    if (holdMs <= 0) return 0;
    const gapToNext = (nextEventAfter(time) ?? time + metricIntervalMs) - time;
    return Math.min(holdMs, Math.max(metricIntervalMs, gapToNext));
  };

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

    // 最老的一个样本向前补一段（见 {@link leadingHoldMs}）：跨度撑到下限、或最老事件是个空槽时，
    // 最老样本在 windowStart 之后，不补的话最左边那格永远差一点点数据。补的量取「这个样本到下一个
    // 事件的实际间隔」而不是全局中位数，免得被本地实测把中位数拉低而补不够。
    const coverStart =
      order === 0
        ? Math.max(sample.time - leadingHoldMs(sample.time), windowStart)
        : sample.time;

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
  windowMs?: number,
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
            windowMs,
          )
        : EMPTY_PING_BUCKETS,
    [count, emptyTimes, enabled, metricIntervalMs, now, offlineSince, samples, windowMs],
  );
}
