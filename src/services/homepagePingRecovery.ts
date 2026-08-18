import { getPingRecords } from "@/services/api";
import { CARRIER_TASK_BY_ID } from "@/services/cfsm/mappers";
import { getPingHistorySnapshot, type PingLiveSample } from "@/services/pingLiveStore";
import type { CarrierKey, CarrierPingSnapshot } from "@/types/cfsm";

/** 首页只在发现明显断档时补一次一小时真实历史。 */
export const HOMEPAGE_RECOVERY_HISTORY_HOURS = 1;
/** 首页恢复检查的时间窗口。 */
export const HOMEPAGE_RECOVERY_WINDOW_MS = 60 * 60 * 1000;
/** 后端首页窗口的正常网格步长：30 格覆盖一小时。 */
export const HOMEPAGE_PING_GRID_STEP_MS = 120_000;
/** 窗口两端至少缺四格才认为是值得查历史的断档。 */
const BOUNDARY_GAP_THRESHOLD_MS = HOMEPAGE_PING_GRID_STEP_MS * 4;
/** 内部至少缺两格才认为是值得查历史的断档。 */
const INTERNAL_GAP_THRESHOLD_MS = HOMEPAGE_PING_GRID_STEP_MS * 2;
/** 成功回填后短时间内刷新页面也不重复打 D1。 */
export const HOMEPAGE_RECOVERY_SUCCESS_TTL_MS = 10 * 60_000;
/** 请求失败时的短暂冷却，避免异常后端造成紧密重试。 */
const HOMEPAGE_RECOVERY_FAILURE_COOLDOWN_MS = 60_000;
const RECOVERY_STORAGE_KEY = "cfsm-luminaplus:homepage-ping-recovery:v1";

const LOSS_KEY_BY_CARRIER: Record<CarrierKey, keyof CarrierPingSnapshot> = {
  ct: "lossCt",
  cu: "lossCu",
  cm: "lossCm",
  bd: "lossBd",
};

const attemptsByUuid = new Map<string, number>();
const successByUuid = new Map<string, number>();
const inFlightByUuid = new Map<string, Promise<boolean>>();

function readStoredSuccess(uuid: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = Number((parsed as Record<string, unknown>)[uuid]);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function rememberSuccess(uuid: string, fetchedAt: number): void {
  successByUuid.set(uuid, fetchedAt);
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const stored =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(stored)) {
      const timestamp = Number(value);
      if (
        Number.isFinite(timestamp) &&
        timestamp > 0 &&
        fetchedAt - timestamp < HOMEPAGE_RECOVERY_SUCCESS_TTL_MS
      ) {
        next[key] = timestamp;
      }
    }
    next[uuid] = fetchedAt;
    window.localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式或配额不足时以内存缓存兜底，不影响当前页面的去重。
  }
}

function hasCarrierMeasurement(
  sample: PingLiveSample,
  carrier: CarrierKey,
): boolean {
  const value = sample.ping[carrier];
  const loss = sample.ping[LOSS_KEY_BY_CARRIER[carrier]];
  return (
    (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (typeof loss === "number" && Number.isFinite(loss))
  );
}

function sortedMeasurementTimes(
  samples: readonly PingLiveSample[],
  carrier: CarrierKey,
  now: number,
  windowStart: number,
): number[] {
  return [...new Set(
    samples
      .filter(
        (sample) =>
          sample.time > 0 &&
          sample.time >= windowStart &&
          sample.time <= now &&
          hasCarrierMeasurement(sample, carrier),
      )
      .map((sample) => sample.time),
  )].sort((left, right) => left - right);
}

function hasReliableUptime(uptimeSeconds: number | null | undefined): uptimeSeconds is number {
  return (
    typeof uptimeSeconds === "number" &&
    Number.isFinite(uptimeSeconds) &&
    uptimeSeconds > 0
  );
}

function resolveWindowStart(
  now: number,
  uptimeSeconds: number | null | undefined,
): number {
  const historyStart = now - HOMEPAGE_RECOVERY_WINDOW_MS;
  if (!hasReliableUptime(uptimeSeconds)) return historyStart;
  // boot_time 已由后端映射成 uptime；节点刚启动时，启动前的空白不是丢失的历史。
  return Math.max(historyStart, now - uptimeSeconds * 1000);
}

function shouldCheckLeadingGap(uptimeSeconds: number | null | undefined): boolean {
  // 已知节点运行不足一小时：leading 区间包含启动前的时间，不把它当成缺口。
  // uptime 不可用时不虚构启动时间，按完整窗口检查，才能覆盖旧节点只剩一两个点的情况。
  return !hasReliableUptime(uptimeSeconds) || uptimeSeconds >= HOMEPAGE_RECOVERY_WINDOW_MS / 1000;
}

/**
 * 判断某条线路是否有「本地实测也没有填上」的明显空洞。
 *
 * 窗口两端和样本之间分别检查：窗口起点到首点的 leading gap、相邻点之间的 internal gap、
 * 以及当前时间到末点的 trailing gap。已知 uptime 且节点运行不足一小时的部分不检查 leading，
 * 避免把启动前的时间误判成缺失；没有任何有效点时不猜测历史存在，避免给新节点平白增加请求。
 */
export function hasSignificantPingGap(
  samples: readonly PingLiveSample[],
  carrier: CarrierKey,
  now = Date.now(),
  uptimeSeconds?: number | null,
): boolean {
  const windowStart = resolveWindowStart(now, uptimeSeconds);
  const times = sortedMeasurementTimes(samples, carrier, now, windowStart);
  if (times.length === 0) return false;

  if (
    shouldCheckLeadingGap(uptimeSeconds) &&
    times[0]! - windowStart > BOUNDARY_GAP_THRESHOLD_MS
  ) {
    return true;
  }

  if (now - times[times.length - 1]! > BOUNDARY_GAP_THRESHOLD_MS) {
    return true;
  }

  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!;
    if (gap > INTERNAL_GAP_THRESHOLD_MS) return true;
  }
  return false;
}

export function shouldRecoverHomepagePing(
  samples: readonly PingLiveSample[],
  taskIds: readonly number[],
  now = Date.now(),
  uptimeSeconds?: number | null,
): boolean {
  const carriers = new Set<CarrierKey>();
  for (const taskId of taskIds) {
    const carrier = CARRIER_TASK_BY_ID.get(taskId)?.key;
    if (carrier) carriers.add(carrier);
  }
  return [...carriers].some((carrier) =>
    hasSignificantPingGap(samples, carrier, now, uptimeSeconds),
  );
}

function isCoolingDown(uuid: string, now: number): boolean {
  const successAt = Math.max(
    successByUuid.get(uuid) ?? 0,
    readStoredSuccess(uuid) ?? 0,
  );
  if (successAt > 0 && now - successAt < HOMEPAGE_RECOVERY_SUCCESS_TTL_MS) {
    successByUuid.set(uuid, successAt);
    return true;
  }

  const attemptedAt = attemptsByUuid.get(uuid) ?? 0;
  return attemptedAt > 0 && now - attemptedAt < HOMEPAGE_RECOVERY_FAILURE_COOLDOWN_MS;
}

/**
 * 对异常节点按需读取一次真实一小时历史。
 *
 * `getPingRecords` 自己还会复用详情页的短期缓存和 in-flight 请求，并在完成后把四条线路
 * 一起回灌 `pingLiveStore`；这里额外记成功 TTL，覆盖刷新页面这一层的重复请求。
 */
export async function requestHomepagePingRecovery(
  uuid: string,
  taskIds: readonly number[],
  now = Date.now(),
  uptimeSeconds?: number | null,
): Promise<boolean> {
  if (
    !uuid ||
    !shouldRecoverHomepagePing(
      getPingHistorySnapshot(uuid),
      taskIds,
      now,
      uptimeSeconds,
    )
  ) {
    return false;
  }

  const inFlight = inFlightByUuid.get(uuid);
  if (inFlight) return inFlight;
  if (isCoolingDown(uuid, now)) return false;

  attemptsByUuid.set(uuid, now);
  const request = getPingRecords(uuid, HOMEPAGE_RECOVERY_HISTORY_HOURS)
    .then(() => {
      rememberSuccess(uuid, Date.now());
      return true;
    })
    .catch(() => false)
    .finally(() => {
      inFlightByUuid.delete(uuid);
    });
  inFlightByUuid.set(uuid, request);
  return request;
}

/** 测试用；不碰业务存储，只清掉本模块的去重状态。 */
export function resetHomepagePingRecovery(): void {
  attemptsByUuid.clear();
  successByUuid.clear();
  inFlightByUuid.clear();
}
