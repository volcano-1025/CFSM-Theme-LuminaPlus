import type { CarrierPingSnapshot } from "@/types/cfsm";

/**
 * 首页延迟条的数据源：由实时数据滚动累积，而不是查历史。
 *
 * `/api/servers` 与 WebSocket 推送里本来就带每台节点的 `ping_ct/cu/cm/bd` 与 `loss_*`，
 * 每次探针上报都会更新。这里把它们按节点存成一个滚动缓冲区，首页直接画这段缓冲区。
 *
 * 这样做的原因是成本：`/api/history/all` 会扫该节点整段时间窗口的历史行，
 * 首页给每台节点每分钟查一次的话，后端 D1 读行会翻几十倍（后端作者实测约 60 倍，
 * 30 秒上报则约 120 倍）。实时累积对后端是零额外请求。
 *
 * 代价是首次打开只有最近这一小会儿的数据，所以缓冲区会写进 localStorage，
 * 刷新后能立刻接上；超过一小时的样本在读取时丢弃。
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
/** 持久化保留同样的条数，这样一小时内回来能直接接上完整图表。 */
const MAX_PERSISTED_SAMPLES = 96;
const MAX_PERSISTED_NODES = 100;
const SAMPLE_TTL_MS = 60 * 60 * 1000;
const STORAGE_KEY = "cfsm-luminaplus:ping-live:v1";
const PERSIST_DEBOUNCE_MS = 15_000;

const EMPTY_SAMPLES: readonly PingLiveSample[] = [];

const samplesByUuid = new Map<string, readonly PingLiveSample[]>();
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
      nodes[uuid] = fresh.slice(-MAX_PERSISTED_SAMPLES).map(toPersisted);
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
  samplesByUuid.set(
    uuid,
    next.length > MAX_SAMPLES_PER_NODE ? next.slice(-MAX_SAMPLES_PER_NODE) : next,
  );
  emit(uuid);
  schedulePersist();
}

export function getPingHistorySnapshot(uuid: string): readonly PingLiveSample[] {
  hydrate();
  return samplesByUuid.get(uuid) ?? EMPTY_SAMPLES;
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
  if (changed) schedulePersist();
}

/** 测试用。 */
export function resetPingLiveStore(): void {
  samplesByUuid.clear();
  listenersByUuid.clear();
  hydrated = false;
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
