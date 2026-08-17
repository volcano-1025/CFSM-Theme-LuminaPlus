import type { LoadRecord } from "@/types/cfsm";

export interface TodayTrafficStat {
  uuid: string;
  trafficUp: number;
  trafficDown: number;
  peakUp: number;
  peakUpAt: number | null;
  peakDown: number;
  peakDownAt: number | null;
  sampleCount: number;
  hasSamples: boolean;
}

export interface TodayTrafficSample {
  timeMs: number;
  up: number;
  down: number;
}

function emptyStat(uuid: string): TodayTrafficStat {
  return {
    uuid,
    trafficUp: 0,
    trafficDown: 0,
    peakUp: 0,
    peakUpAt: null,
    peakDown: 0,
    peakDownAt: null,
    sampleCount: 0,
    hasSamples: false,
  };
}

function recordTimeMs(record: LoadRecord): number {
  return Number.isFinite(record.time) ? record.time : Number.NaN;
}

/**
 * 单个采样点最多按多长时间积分。
 *
 * 探针掉线再上线会在历史里留下很大的时间空洞；如果按空洞长度乘以恢复后的瞬时速率，
 * 会凭空造出巨量流量。超过这个上限的间隔按上限计入。
 */
const MAX_SAMPLE_SPAN_MS = 10 * 60 * 1000;

/**
 * 离群速率钳制：某个方向的瞬时速率若高于当日中位速率的这个倍数，积分时按上界截断。
 *
 * `/api/history/all` 的降采样每次挑的代表点不完全一样，偶发的高速尖峰这次返回、下次没返回；
 * 由于总量是"速率 × 时间"积分，单个尖峰采样点（乘以数分钟的间隔）就能凭空造出好几 GB，于是
 * 同一天重新打开就可能从 24 GB 跳到 200 MB。这里用中位数做稳健基准，把远超日常的单点毛刺压回
 * 上界——真实的持续高流量会抬高中位数、不会被钳（倍数留了充足余量）；代价是真实的极短爆发会被
 * 略微低估，但"今日总量"要的是稳定合理，而不是抓住每一次瞬时尖峰。
 */
const OUTLIER_SPEED_FACTOR = 10;
/** 样本太少时中位数不可靠，不做钳制（点也少、影响本就有限）。 */
const OUTLIER_MIN_SAMPLES = 5;

/** 正速率的中位数 × 倍数作为上界；样本不足或全为 0 时返回 +∞（即不钳制）。 */
function robustSpeedCap(values: number[]): number {
  const positive = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (positive.length < OUTLIER_MIN_SAMPLES) return Number.POSITIVE_INFINITY;
  const mid = Math.floor(positive.length / 2);
  const median =
    positive.length % 2 === 0 ? (positive[mid - 1]! + positive[mid]!) / 2 : positive[mid]!;
  return median > 0 ? median * OUTLIER_SPEED_FACTOR : Number.POSITIVE_INFINITY;
}

/**
 * 由速率采样积分出区间流量。
 *
 * CF-Server-Monitor 的历史表只保存 `net_in_speed` / `net_out_speed` 瞬时速率，
 * 没有累计计数器，所以"今日流量"只能是估算值。为此做两件事让估算更稳、更贴近真实：
 * 相邻两个区间内采样点用**梯形积分**（两点速率取平均再乘间隔，去掉系统性高估、尖峰影响减半）；
 * 并对**单点离群速率**做钳制（见 {@link robustSpeedCap}），避免后端偶发返回的高速毛刺把总量带飞。
 * 采样越稀疏（默认 120 个点/查询区间）误差越大。
 */
export function summarizeTodayTrafficRecords(
  uuid: string,
  records: LoadRecord[],
  startMs: number,
  endMs: number,
): TodayTrafficStat {
  const stat = emptyStat(uuid);
  const sorted = records
    .map((record) => ({ record, timeMs: recordTimeMs(record) }))
    .filter(({ timeMs }) => Number.isFinite(timeMs) && timeMs <= endMs)
    .sort((left, right) => left.timeMs - right.timeMs);

  const rawOut = (record: LoadRecord) =>
    Number.isFinite(record.net_out) ? Math.max(0, record.net_out) : 0;
  const rawIn = (record: LoadRecord) =>
    Number.isFinite(record.net_in) ? Math.max(0, record.net_in) : 0;

  // 中位数只看区间内的样本；上界据此得出，钳制对上/下行各算各的。
  const inRange = sorted.filter(({ timeMs }) => timeMs >= startMs);
  const capUp = robustSpeedCap(inRange.map(({ record }) => rawOut(record)));
  const capDown = robustSpeedCap(inRange.map(({ record }) => rawIn(record)));

  let previousTimeMs: number | null = null;
  let previousWasInRange = false;
  let previousUp = 0;
  let previousDown = 0;

  for (const { record, timeMs } of sorted) {
    const clampedUp = Math.min(rawOut(record), capUp);
    const clampedDown = Math.min(rawIn(record), capDown);

    if (timeMs < startMs) {
      // 区间开始前的最后一个采样点只提供时间基准，其速率来自昨天、不并入总量。
      previousTimeMs = timeMs;
      previousWasInRange = false;
      previousUp = clampedUp;
      previousDown = clampedDown;
      continue;
    }

    stat.hasSamples = true;
    stat.sampleCount += 1;

    if (previousTimeMs != null) {
      const spanMs = Math.min(MAX_SAMPLE_SPAN_MS, Math.max(0, timeMs - previousTimeMs));
      // 相邻两个区间内采样点用梯形积分（两点速率取平均）；与区间前基准点之间仍按当前点速率的
      // 矩形口径（基准点只提供时间、速率来自昨天，不参与平均）。
      const upRate = previousWasInRange ? (previousUp + clampedUp) / 2 : clampedUp;
      const downRate = previousWasInRange ? (previousDown + clampedDown) / 2 : clampedDown;
      stat.trafficUp += (upRate * spanMs) / 1000;
      stat.trafficDown += (downRate * spanMs) / 1000;
    }

    // 峰值报告真实观测到的最大瞬时速率，不做离群钳制——它本就是"最快的一瞬"，钳掉会掩盖真实观测；
    // 钳制只作用于总量估算。
    const observedUp = rawOut(record);
    const observedDown = rawIn(record);
    if (observedUp > stat.peakUp) {
      stat.peakUp = observedUp;
      stat.peakUpAt = timeMs;
    }
    if (observedDown > stat.peakDown) {
      stat.peakDown = observedDown;
      stat.peakDownAt = timeMs;
    }

    previousTimeMs = timeMs;
    previousWasInRange = true;
    previousUp = clampedUp;
    previousDown = clampedDown;
  }

  return stat;
}

export function buildTodayTrafficRecordSamples(
  records: LoadRecord[],
  startMs: number,
  endMs: number,
): TodayTrafficSample[] {
  return records
    .map((record) => ({ record, timeMs: recordTimeMs(record) }))
    .filter(
      ({ timeMs }) => Number.isFinite(timeMs) && timeMs >= startMs && timeMs <= endMs,
    )
    .map(({ record, timeMs }) => ({
      timeMs,
      up: Math.max(0, Number.isFinite(record.net_out) ? record.net_out : 0),
      down: Math.max(0, Number.isFinite(record.net_in) ? record.net_in : 0),
    }))
    .sort((left, right) => right.timeMs - left.timeMs);
}
