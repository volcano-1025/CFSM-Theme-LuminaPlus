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
 * 由速率采样积分出区间流量。
 *
 * CF-Server-Monitor 的历史表只保存 `net_in_speed` / `net_out_speed` 瞬时速率，
 * 没有累计计数器，所以"今日流量"只能是估算值：每个采样点用它与前一个采样点的
 * 时间差乘以当前速率。采样越稀疏（默认 120 个点/查询区间）误差越大。
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

  let previousTimeMs: number | null = null;
  for (const item of sorted) {
    const { record, timeMs } = item;
    if (timeMs < startMs) {
      previousTimeMs = timeMs;
      continue;
    }

    stat.hasSamples = true;
    stat.sampleCount += 1;

    const netOut = Number.isFinite(record.net_out) ? Math.max(0, record.net_out) : 0;
    const netIn = Number.isFinite(record.net_in) ? Math.max(0, record.net_in) : 0;
    if (previousTimeMs != null) {
      // 区间开始前的最后一个采样点只提供时间基准，速率归到区间内的第一个点上。
      const spanMs = Math.min(MAX_SAMPLE_SPAN_MS, Math.max(0, timeMs - previousTimeMs));
      stat.trafficUp += (netOut * spanMs) / 1000;
      stat.trafficDown += (netIn * spanMs) / 1000;
    }

    if (netOut > stat.peakUp) {
      stat.peakUp = netOut;
      stat.peakUpAt = timeMs;
    }
    if (netIn > stat.peakDown) {
      stat.peakDown = netIn;
      stat.peakDownAt = timeMs;
    }
    previousTimeMs = timeMs;
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
