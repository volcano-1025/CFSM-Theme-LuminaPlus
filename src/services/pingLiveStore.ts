import type { CarrierPingSnapshot } from "@/types/cfsm";

/**
 * 首页延迟条的数据源。
 *
 * 两个来源：
 *
 * 1. **后端窗口**（Workers 2.8.3 Beta2 起）：`/api/servers` 直接给出每台节点最近一小时的
 *    探测窗口 —— 30 个槽位、每 2 分钟一个。首屏就是完整的一小时，由 `seedPingHistory` 灌入。
 * 2. **实时累积**：`/api/servers` 与 WebSocket 推送里一直都有 `ping_ct/cu/cm/bd` 与 `loss_*`
 *    当前值，由 `recordPingSample` 逐点累积。兜底旧版后端（那时没有窗口字段，只能从零攒），
 *    以及新版后端窗口停止滑动时补中间的空洞。
 *
 * **有窗口时以窗口为准，本地点只补缺口**，理由见 {@link mergeWindowWithLocal}。
 *
 * 两者都不查 `/api/history/all`：那个接口会扫节点整段时间窗口的历史行，
 * 首页给每台节点每分钟查一次会让后端 D1 读行翻几十倍（后端作者实测约 60 倍，
 * 30 秒上报则约 120 倍）。
 *
 * 缓冲区会写进 localStorage，旧版后端下刷新也能立刻接上；超过一小时的样本在读取时丢弃。
 */

export interface PingLiveSample {
  time: number;
  ping: CarrierPingSnapshot;
}

type Listener = () => void;

/**
 * 两次采样之间的最小间隔。
 *
 * WebSocket 每 5 秒推一批，但探针默认 60 秒才测一次 ping，多数批次里的 ping 值是重复的。
 * 首页图表又是按 150 秒一格聚合的，采样比 ~75 秒更密不会带来任何可见差异，
 * 却会让固定长度的缓冲区只覆盖几分钟。这里按 50 秒节流：60 秒上报时每次上报采一个点，
 * 30 秒上报时隔一次采一个点，每格仍有 2~3 个样本。
 */
const MIN_SAMPLE_GAP_MS = 50_000;
/** 值发生变化时允许更快记录，但仍要防住 5 秒一批的抖动。 */
const MIN_CHANGED_SAMPLE_GAP_MS = 20_000;
/** 50 秒一个样本时，96 条覆盖 80 分钟，足够铺满一小时的图表。 */
const MAX_SAMPLES_PER_NODE = 96;
/** 抽稀后相邻样本的最小间隔：一小时铺满上限条数，保证覆盖整段窗口。 */
const MIN_THINNED_GAP_MS = (60 * 60 * 1000) / MAX_SAMPLES_PER_NODE;
/** 后端窗口的网格步长推不出来时的兜底：实测是 2 分钟一格。 */
const DEFAULT_WINDOW_STEP_MS = 120_000;
/** 窗口相邻两点间隔超过步长的几倍，才算「缺了一段」、需要本地点来补。 */
const GAP_FILL_STEP_FACTOR = 2;
const MAX_PERSISTED_NODES = 100;
const SAMPLE_TTL_MS = 60 * 60 * 1000;
const STORAGE_KEY = "cfsm-luminaplus:ping-live:v1";
const PERSIST_DEBOUNCE_MS = 15_000;

const EMPTY_SAMPLES: readonly PingLiveSample[] = [];

/** 本地实时累积（会持久化）。 */
const samplesByUuid = new Map<string, readonly PingLiveSample[]>();
/** 后端下发的一小时窗口，按节点存最近一份。 */
const windowByUuid = new Map<string, readonly PingLiveSample[]>();
/** 对外可见的合并结果，引用稳定（`useSyncExternalStore` 要求）。 */
const seriesByUuid = new Map<string, readonly PingLiveSample[]>();
const listenersByUuid = new Map<string, Set<Listener>>();
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function hasAnyValue(ping: CarrierPingSnapshot): boolean {
  return (
    ping.ct != null || ping.cu != null || ping.cm != null || ping.bd != null
  );
}

function isFresh(sample: PingLiveSample, now: number): boolean {
  return sample.time > 0 && now - sample.time <= SAMPLE_TTL_MS;
}

/**
 * 超出条数上限时按时间**均匀抽稀**，而不是砍掉最老的那些。
 *
 * 缓冲区里两种样本疏密差很多：后端窗口是 2 分钟一个、覆盖整小时，本地累积约 20 秒一个、
 * 只覆盖最近半小时。直接 `slice(-N)` 会被密集的近期样本占满，把窗口里较早的点整段丢掉 ——
 * 首页柱子于是左半段（较早）空、右半段有。这里从最新往回留，相邻保留点至少隔
 * {@link MIN_THINNED_GAP_MS}，于是无论哪种疏密都能铺满整小时。
 */
function thinSamples(samples: readonly PingLiveSample[]): PingLiveSample[] {
  if (samples.length <= MAX_SAMPLES_PER_NODE) return [...samples];

  const kept: PingLiveSample[] = [];
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!;
    const last = kept[kept.length - 1];
    if (!last || last.time - sample.time >= MIN_THINNED_GAP_MS) kept.push(sample);
  }
  kept.reverse();
  // 抽稀后仍超上限（样本比一小时还密时）才退回保留最新的那批。
  return kept.length > MAX_SAMPLES_PER_NODE
    ? kept.slice(-MAX_SAMPLES_PER_NODE)
    : kept;
}

function samePing(a: CarrierPingSnapshot, b: CarrierPingSnapshot): boolean {
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

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */

/** 紧凑格式：[time, ct, cu, cm, bd, lossCt, lossCu, lossCm, lossBd] */
type PersistedSample = [
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

function toPersisted(sample: PingLiveSample): PersistedSample {
  const { ping } = sample;
  return [
    sample.time,
    ping.ct,
    ping.cu,
    ping.cm,
    ping.bd,
    ping.lossCt,
    ping.lossCu,
    ping.lossCm,
    ping.lossBd,
  ];
}

function fromPersisted(entry: unknown): PingLiveSample | null {
  if (!Array.isArray(entry) || entry.length < 9) return null;
  const time = Number(entry[0]);
  if (!Number.isFinite(time) || time <= 0) return null;

  const value = (index: number): number | null => {
    const raw = entry[index];
    if (raw == null) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  };

  return {
    time,
    ping: {
      ct: value(1),
      cu: value(2),
      cm: value(3),
      bd: value(4),
      lossCt: value(5),
      lossCu: value(6),
      lossCm: value(7),
      lossBd: value(8),
    },
  };
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const nodes = (parsed as { nodes?: unknown }).nodes;
    if (!nodes || typeof nodes !== "object") return;

    const now = Date.now();
    for (const [uuid, entries] of Object.entries(nodes as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      const samples = entries
        .map(fromPersisted)
        .filter((sample): sample is PingLiveSample => sample != null && isFresh(sample, now))
        .sort((left, right) => left.time - right.time);
      if (samples.length > 0) samplesByUuid.set(uuid, samples);
    }
  } catch {
    // 缓存损坏时当作没有历史，重新累积即可。
  }
}

function persistNow(): void {
  try {
    const now = Date.now();
    const nodes: Record<string, PersistedSample[]> = {};
    let count = 0;
    for (const [uuid, samples] of samplesByUuid) {
      if (count >= MAX_PERSISTED_NODES) break;
      const fresh = samples.filter((sample) => isFresh(sample, now));
      if (fresh.length === 0) continue;
      nodes[uuid] = thinSamples(fresh).map(toPersisted);
      count += 1;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, savedAt: now, nodes }));
  } catch {
    // 配额用尽或隐私模式：内存里的缓冲区照常工作，只是刷新后要重新累积。
  }
}

function schedulePersist(): void {
  if (persistTimer != null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

if (typeof window !== "undefined") {
  // 关闭/切走标签页时立刻落盘，避免丢掉最后一个防抖窗口内的样本。
  window.addEventListener("pagehide", () => {
    if (persistTimer != null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (samplesByUuid.size > 0) persistNow();
  });
}

/* ------------------------------------------------------------------ *
 * 合并
 * ------------------------------------------------------------------ */

/**
 * 窗口的网格步长。
 *
 * 取相邻间隔的**中位数**：末尾那个「当前」点常常离上一格好几分钟（后端窗口并不严格
 * 滑动），取平均或最大值都会被它带偏，取最小值又会被偶发的重复时间戳带偏。
 */
function resolveWindowStepMs(window: readonly PingLiveSample[]): number {
  const gaps: number[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const gap = window[index]!.time - window[index - 1]!.time;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return DEFAULT_WINDOW_STEP_MS;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * 后端窗口为准，本地累积只补缺口。
 *
 * 两个来源的口径不一样：窗口是后端按 2 分钟网格算好的，本地是 WS 当前值 20~50 秒攒一个。
 * 早先按时间戳取并集，于是同一格里混着两种样本 —— 丢包按样本数加权平均之后，首页既不等于
 * 后端窗口自己算的、也不等于详情页历史算的，而且本地点越攒越多、比例还会随开着页面的时间漂移
 * （用户看到的「首页数据不对」多半是这个）。
 *
 * 现在只有窗口自己缺了一段（相邻两点间隔超过步长的 {@link GAP_FILL_STEP_FACTOR} 倍）才用本地点
 * 去填那段：正常情况下一个本地点都不参与，首页口径与 `/api/servers` 完全一致，柱子跟着窗口
 * 每 2 分钟动一次；窗口停止滑动时（实测会铺到 35 分钟前就停、末尾直接追加一个当前点），
 * 中间那段空洞仍由本地点补上 —— 这正是当初要取并集的原因，不能直接丢掉。
 */
function mergeWindowWithLocal(
  window: readonly PingLiveSample[],
  local: readonly PingLiveSample[],
  now: number,
): readonly PingLiveSample[] {
  if (window.length === 0) return local;
  if (local.length === 0) return window;

  const step = resolveWindowStepMs(window);
  const minGapMs = step * GAP_FILL_STEP_FACTOR;
  // 缺口两端各留半格，免得补进来的点和网格点挤在同一格里重复计权。
  const margin = step / 2;
  const out: PingLiveSample[] = [];
  let cursor = 0;

  /** 取 (from, to) 之间的本地样本；游标只前进，窗口点是升序的。 */
  const takeLocal = (from: number, to: number): PingLiveSample[] => {
    const picked: PingLiveSample[] = [];
    while (cursor < local.length && local[cursor]!.time <= from) cursor += 1;
    while (cursor < local.length && local[cursor]!.time < to) {
      picked.push(local[cursor]!);
      cursor += 1;
    }
    return picked;
  };

  for (const [index, point] of window.entries()) {
    const previous = index > 0 ? window[index - 1]! : null;
    if (previous && point.time - previous.time > minGapMs) {
      out.push(...takeLocal(previous.time + margin, point.time - margin));
    }
    // 「格子在、值是 null」的槽位（后端这轮探测没出结果）：图表本来会真的留空 —— 那是对的，
    // 可本地要是正好在那段时间实测到了值，留空就成了自找的空洞（线上看到的「柱子中间缺一格」
    // 就是它，v1.2.6 靠并集顺手盖住了）。所以这种槽位允许被邻近的本地样本顶替；
    // 邻近也没有本地样本时仍旧留空，不编数据。
    if (!hasAnyValue(point.ping)) {
      const replacement = takeLocal(point.time - margin, point.time + margin);
      if (replacement.length > 0) {
        out.push(...replacement);
        continue;
      }
    }
    out.push(point);
  }

  // 窗口末点到「现在」之间也可能缺一段（后端快照迟迟不更新），同样用本地点补。
  const last = window[window.length - 1]!;
  if (now - last.time > minGapMs) out.push(...takeLocal(last.time + margin, now + margin));

  return out;
}

function computeSeries(uuid: string, now: number): readonly PingLiveSample[] {
  const window = (windowByUuid.get(uuid) ?? EMPTY_SAMPLES).filter((sample) =>
    isFresh(sample, now),
  );
  const local = (samplesByUuid.get(uuid) ?? EMPTY_SAMPLES).filter((sample) =>
    isFresh(sample, now),
  );
  if (window.length === 0 && local.length === 0) return EMPTY_SAMPLES;
  return thinSamples(mergeWindowWithLocal(window, local, now));
}

/** 写入之后重算；内容没变就保持原引用，也不惊动订阅者。 */
function refreshSeries(uuid: string, now: number): void {
  const next = computeSeries(uuid, now);
  const current = seriesByUuid.get(uuid);
  if (current && sameSeries(current, next)) return;
  seriesByUuid.set(uuid, next);
  emit(uuid);
}

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

function emit(uuid: string): void {
  const listeners = listenersByUuid.get(uuid);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

/**
 * 记录一次上报。重复的上报时间、以及节流窗口内的重复值都会被忽略，
 * 因此调用方可以在每次收到推送时无脑调用。
 */
export function recordPingSample(
  uuid: string,
  time: number,
  ping: CarrierPingSnapshot,
): void {
  if (!uuid || !Number.isFinite(time) || time <= 0) return;
  if (!hasAnyValue(ping)) return;

  hydrate();
  const previous = samplesByUuid.get(uuid) ?? EMPTY_SAMPLES;
  const last = previous[previous.length - 1];
  if (last) {
    if (last.time >= time) return;
    const gap = time - last.time;
    // 值没变就按正常节奏采样；值变了可以早一点记录，但仍要防住 5 秒一批的抖动。
    const minGap = samePing(last.ping, ping)
      ? MIN_SAMPLE_GAP_MS
      : MIN_CHANGED_SAMPLE_GAP_MS;
    if (gap < minGap) return;
  }

  const now = Date.now();
  const next = [...previous.filter((sample) => isFresh(sample, now)), { time, ping }];
  samplesByUuid.set(uuid, thinSamples(next));
  refreshSeries(uuid, now);
  schedulePersist();
}

function sameSeries(a: readonly PingLiveSample[], b: readonly PingLiveSample[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.time !== right.time || !samePing(left.ping, right.ping)) return false;
  }
  return true;
}

/**
 * 记下后端下发的窗口。
 *
 * 只存一份最新的，不与本地累积做并集 —— 合并规则见 {@link mergeWindowWithLocal}。
 * 空窗口（旧版后端）直接忽略，让本地累积继续兜底。
 */
export function seedPingHistory(
  uuid: string,
  window: readonly PingLiveSample[],
): void {
  if (!uuid || window.length === 0) return;

  hydrate();
  const now = Date.now();
  const fresh = [...window]
    .filter((sample) => isFresh(sample, now))
    .sort((left, right) => left.time - right.time);
  if (fresh.length === 0) return;

  const previous = windowByUuid.get(uuid);
  // 后端窗口每次刷新基本原样返回，内容没变就连重算都省掉。
  if (previous && sameSeries(previous, fresh)) return;
  windowByUuid.set(uuid, fresh);
  refreshSeries(uuid, now);
}

export function getPingHistorySnapshot(uuid: string): readonly PingLiveSample[] {
  hydrate();
  const cached = seriesByUuid.get(uuid);
  if (cached) return cached;
  // 刚 hydrate 出来的持久化缓冲还没算过合并结果；这里补算并缓存，不能 emit
  // （getSnapshot 会在 React 渲染期间被调用）。
  const next = computeSeries(uuid, Date.now());
  if (next.length === 0) return EMPTY_SAMPLES;
  seriesByUuid.set(uuid, next);
  return next;
}

export function subscribePingHistory(uuid: string, listener: Listener): () => void {
  let listeners = listenersByUuid.get(uuid);
  if (!listeners) {
    listeners = new Set();
    listenersByUuid.set(uuid, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) listenersByUuid.delete(uuid);
  };
}

/** 节点被删除后清掉它的缓冲区，避免无限增长。 */
export function retainPingNodes(uuids: Iterable<string>): void {
  const keep = new Set(uuids);
  let changed = false;
  for (const uuid of [...samplesByUuid.keys()]) {
    if (keep.has(uuid)) continue;
    samplesByUuid.delete(uuid);
    changed = true;
  }
  for (const uuid of [...windowByUuid.keys()]) {
    if (!keep.has(uuid)) windowByUuid.delete(uuid);
  }
  for (const uuid of [...seriesByUuid.keys()]) {
    if (!keep.has(uuid)) seriesByUuid.delete(uuid);
  }
  if (changed) schedulePersist();
}

/** 测试用。 */
export function resetPingLiveStore(): void {
  samplesByUuid.clear();
  windowByUuid.clear();
  seriesByUuid.clear();
  listenersByUuid.clear();
  hydrated = false;
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
