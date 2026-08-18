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
 * 这个 store 自己不发 `/api/history/all`：那个接口会扫节点整段时间窗口的历史行，
 * 首页给每台节点每分钟查一次会让后端 D1 读行翻几十倍（后端作者实测约 60 倍，
 * 30 秒上报则约 120 倍）。首页只在外层检测到明显空洞时按节点触发一次恢复请求。
 *
 * 本地实测缓冲区会持久化：首屏通常由后端窗口给，本地点只补窗口缺口；
 * 历史恢复或详情回灌后也能在短时间内跨刷新保留真实样本。超过一小时的样本读取时丢弃。
 */

export interface PingLiveSample {
  time: number;
  ping: CarrierPingSnapshot;
  /**
   * 这个样本在丢包加权平均里算几份。合并时才算出来，不落盘。
   *
   * 两个来源疏密不同（窗口 2 分钟一格，本地跟着探测节奏、平稳时 2 分钟一个心跳），而丢包率是按**样本条数**
   * 加权的。不配权重的话，密的那段说话就大声几倍，卡片上的丢包率会被它拖着走。
   */
  weight?: number;
}

type Listener = () => void;

/**
 * 采样口径：**一次探测结果记一个样本**。
 *
 * WebSocket 每两秒推一帧，但探针默认 60 秒才测一次 ping —— 帧里的 ping 值只在新探测落地时
 * 才变。所以「值变了就记」正好等于「每次探测记一次」，只留一个很小的下限防抖。
 *
 * 早先是「值没变 50 秒记一个、值变了 20 秒就放行」，这个不对称会在每次丢包的**切换处**多记
 * 一个样本 —— 丢包的样本被系统性多记，丢包率随之偏高。构造实测：60 次探测（其中 8 次丢包
 * 16.7%）被记成 78 个样本，真值 2.50% 算成 3.85%，高估 54%。
 */
const MIN_CHANGED_SAMPLE_GAP_MS = 5_000;
/**
 * 值没变时的心跳采样：一格（2 分钟）留一个点。
 *
 * 单纯「值变了才记」会让长期平稳的节点一小时只有一两个样本，柱子没法画（样本向后延续有上限）。
 * 心跳只补密度，不影响加权 —— 权重是按样本代表的时长算的。
 */
const MIN_SAMPLE_GAP_MS = 120_000;
/** 一小时的图表要铺满 30 格；96 条留足余量（详情页历史回灌时会密一些）。 */
const MAX_SAMPLES_PER_NODE = 96;
/** 抽稀后相邻样本的最小间隔：一小时铺满上限条数，保证覆盖整段窗口。 */
const MIN_THINNED_GAP_MS = (60 * 60 * 1000) / MAX_SAMPLES_PER_NODE;
/** 后端窗口的网格步长推不出来时的兜底：实测是 2 分钟一格。 */
const DEFAULT_WINDOW_STEP_MS = 120_000;
/** 本地样本间隔推不出来时的兜底。 */
const DEFAULT_LOCAL_CADENCE_MS = 40_000;
/**
 * 权重的基数：一个「满格」（step 那么长的时间）算几份。
 *
 * `resolvePingSampleCounts` 会把权重取整，基数太小会被舍入带偏（1 : 1.5 取成 1 : 2，
 * 凭空多给一方三成），取 8 让常见的疏密比都能落在整数附近。
 */
const WEIGHT_SCALE = 8;
const SAMPLE_TTL_MS = 60 * 60 * 1000;
const MAX_PERSISTED_NODES = 100;
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
 * 缓冲区里几种样本疏密差很多：后端窗口 2 分钟一个、覆盖整小时；本地实测只覆盖页面开着的那段；
 * 详情页回灌的历史约 30 秒一行。直接 `slice(-N)` 会被密集的近期样本占满，把较早的点整段丢掉 ——
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
  if (kept.length <= MAX_SAMPLES_PER_NODE) return kept;

  // 还超上限就加大间隔再抽一轮。这里**不能** `slice(-N)` —— 那会整段砍掉最老的，
  // 而最老的那半段往往正是后端窗口独有、本地没覆盖到的部分，砍掉柱子就左半段空。
  const span = kept[kept.length - 1]!.time - kept[0]!.time;
  const gap = Math.max(MIN_THINNED_GAP_MS, span / MAX_SAMPLES_PER_NODE);
  const sparse: PingLiveSample[] = [];
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const sample = kept[index]!;
    const last = sparse[sparse.length - 1];
    if (!last || last.time - sample.time >= gap) sparse.push(sample);
  }
  sparse.reverse();
  return sparse;
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

/** 本地样本的实际疏密（相邻间隔中位数）。 */
function resolveCadenceMs(samples: readonly PingLiveSample[]): number {
  const gaps: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const gap = samples[index]!.time - samples[index - 1]!.time;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return DEFAULT_LOCAL_CADENCE_MS;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * 本地实测优先，后端窗口只补浏览器还没覆盖到的时段。
 *
 * 一度反过来做过（窗口权威、本地只补缺口），线上数据证明那是错的：`/api/servers` 的窗口
 * 并不是把探测结果聚合出来的，而是**拿最近一次结果向后填充**。线上实测某节点的一小时窗口里，
 * 前 24 格（48 分钟）是同一个数字重复，只有最后 6 格是真值；同一时段的历史接口有 114 行真实
 * 采样，延迟从 235 到 1283 都有、丢包 5.5%，而按窗口算只有 1.1%。也就是说窗口是低保真的
 * 填充产物，浏览器自己从 WebSocket 攒的样本才是真测量 —— 有真的就不该用填出来的。
 *
 * 于是：
 * - 本地样本原样保留（保留全部细节，尖峰不会被抹平）；
 * - 窗口点只在附近半格内没有本地样本时才要 —— 那是浏览器打开之前、或标签页被挂起的时段；
 * - 窗口点配一个权重（抵几个本地点），否则一小时里「本地那半段」的样本条数是「窗口那半段」的
 *   三四倍，丢包率会随页面开着的时长往本地那半段偏 —— 当初那个漂移就是这么来的。
 *
 * 权重只影响丢包/延迟的加权平均，不影响柱子画在哪一格。
 */
function mergeWindowWithLocal(
  window: readonly PingLiveSample[],
  local: readonly PingLiveSample[],
  now: number,
): readonly PingLiveSample[] {
  if (window.length === 0) return assignWeights(local, DEFAULT_WINDOW_STEP_MS, now);
  if (local.length === 0) return assignWeights(window, resolveWindowStepMs(window), now);

  const step = resolveWindowStepMs(window);
  const cadence = resolveCadenceMs(local);
  // 一段本地样本之间隔得比这还远，就当中间断了（标签页被挂起、或刚打开页面），
  // 那段仍旧交给窗口。取 cadence 的两倍，偶尔慢一拍不算断。
  const maxLocalGap = Math.max(step, cadence * 2);

  const out: PingLiveSample[] = [];
  let cursor = 0;
  for (const point of window) {
    while (cursor < local.length && local[cursor]!.time <= point.time) {
      out.push(local[cursor]!);
      cursor += 1;
    }
    // 这一刻的前后都有本地样本、且中间没断，就说明浏览器实测覆盖到了这里。
    const before = cursor > 0 ? local[cursor - 1]! : null;
    const after = cursor < local.length ? local[cursor]! : null;
    const covered =
      before != null && after != null && after.time - before.time <= maxLocalGap;
    if (covered) continue;
    // 「格子在、值是 null」的槽位（后端那轮探测没出结果）：图表对明确没值的槽位是真的
    // 留空的，附近只要有一个本地实测点就让它顶上，不然平白空一格。
    if (
      !hasAnyValue(point.ping) &&
      [before, after].some(
        (near) => near != null && Math.abs(near.time - point.time) <= step,
      )
    ) {
      continue;
    }
    out.push(point);
  }
  for (; cursor < local.length; cursor += 1) out.push(local[cursor]!);

  return assignWeights(out, step, now);
}

/**
 * 每个样本按**它代表多长时间**计权，而不是「一条算一条」。
 *
 * 时长的口径必须和图表一致：**一个样本代表「到下一次采样为止」的那段时间**（`buildPingBuckets`
 * 就是这么铺格子的），不是「到前后邻居的中点」。差别在采样疏密不均的地方会翻车 —— 探针 60 秒
 * 一次探测，平稳时每 2 分钟才记一个心跳，丢包那一次却会立刻记下来：按中点算，这个只代表 60 秒
 * 的丢包样本会拿到 90 秒的权重，丢包率凭空高一半（栽过一次，构造实测高估 71%）。
 *
 * 它同时抹平两处偏差：① 后端窗口 2 分钟一个点、本地样本疏密不定，按条数平均会偏向密的那段；
 * ② 采样规则本身对「值变了」放行更快，丢包样本更容易被记下。
 */
function assignWeights(
  samples: readonly PingLiveSample[],
  stepMs: number,
  now: number,
): PingLiveSample[] {
  return samples.map((sample, index) => {
    const next = samples[index + 1];
    const span = (next ? next.time : now) - sample.time;
    // 末尾那个样本和异常间隔都夹在合理范围内，免得一个孤点顶掉半张图的权重。
    const bounded = Math.min(Math.max(span, stepMs / 8), stepMs * 4);
    return { ...sample, weight: Math.max(1, Math.round((WEIGHT_SCALE * bounded) / stepMs)) };
  });
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
    // 权重也要比：窗口到达后本地样本可能一个没变，变的只是权重（原先只有本地、
    // 现在要和窗口按时长配比），漏比就会把新算的加权序列判成「没变」而丢掉。
    if (
      left.time !== right.time ||
      left.weight !== right.weight ||
      !samePing(left.ping, right.ping)
    ) {
      return false;
    }
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

/**
 * 把详情页查回来的历史采样灌进本地缓冲。
 *
 * 和 WS 攒的样本同级（都是真测量），按时间戳取并集、同一时刻以历史为准 —— 历史是后端那张表
 * 里的原始记录，比 WS 当前值更完整（30 秒一行 vs 探测落地才变）。
 *
 * 不增加额外后端请求：调用点在详情页已经发出的查询，或首页异常恢复请求的回调里。
 */
export function seedMeasuredHistory(
  uuid: string,
  samples: readonly PingLiveSample[],
): void {
  if (!uuid || samples.length === 0) return;

  hydrate();
  const now = Date.now();
  const byTime = new Map<number, PingLiveSample>();
  for (const sample of samplesByUuid.get(uuid) ?? EMPTY_SAMPLES) {
    if (isFresh(sample, now)) byTime.set(sample.time, sample);
  }
  let added = 0;
  for (const sample of samples) {
    if (!isFresh(sample, now) || !hasAnyValue(sample.ping)) continue;
    byTime.set(sample.time, sample);
    added += 1;
  }
  if (added === 0) return;

  const merged = [...byTime.values()].sort((left, right) => left.time - right.time);
  samplesByUuid.set(uuid, thinSamples(merged));
  refreshSeries(uuid, now);
  schedulePersist();
}

export function getPingHistorySnapshot(uuid: string): readonly PingLiveSample[] {
  hydrate();
  const cached = seriesByUuid.get(uuid);
  if (cached) return cached;
  // 还没算过合并结果时补算并缓存，但不能 emit
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
