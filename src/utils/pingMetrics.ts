import type { PingRecord } from "@/types/cfsm";

/**
 * 把一条 Ping 样本还原成"总数/丢失/有效"三元组。
 *
 * CF-Server-Monitor 的历史每行只有一次探测结果，`count` 恒为 1；`loss` 是该次采样的
 * 丢包百分比。`value < 0` 视为整点丢失。
 *
 * `lost` 保留小数：后端给的是百分比而不是丢了几个包，四舍五入成整数会把 33% 抹成 0、
 * 把 50% 抹成 100%，聚合出来的丢包率只剩 0 和 100 两种值。
 */
export function resolvePingSampleCounts(
  sample: Pick<PingRecord, "value" | "count" | "loss">,
) {
  const total =
    typeof sample.count === "number" && Number.isFinite(sample.count) && sample.count > 0
      ? Math.max(1, Math.round(sample.count))
      : 1;
  const reportedLoss = sample.loss;
  const lost =
    typeof reportedLoss === "number" && Number.isFinite(reportedLoss)
      ? Math.min(total, Math.max(0, (reportedLoss / 100) * total))
      : sample.value < 0
        ? total
        : 0;
  return { total, lost, valid: total - lost };
}

export interface PingLossSample {
  time: number;
  lost: number;
  total: number;
}

/**
 * 把原始丢包样本归并到图表降采样后的时间格上。
 *
 * 必须用加权平均（lost/total），不能像延迟那样取桶内极值：一桶里出现一次 100% 丢包
 * 就把整段染红，读者会以为断了几分钟。
 *
 * 对齐方式是「就近归入最接近的目标时刻」——降采样用的是等宽时间桶，桶心即目标时刻，
 * 就近归并与原桶划分至多差一格，而一格在屏幕上不到 1px。
 * 返回值与 targetTimes 等长：该格没有任何样本时是 null（无数据），有样本才是百分比。
 */
export function bucketPingLoss(
  samples: PingLossSample[],
  targetTimes: number[],
): Array<number | null> {
  const out = new Array<number | null>(targetTimes.length).fill(null);
  if (targetTimes.length === 0 || samples.length === 0) return out;

  const lost = new Array<number>(targetTimes.length).fill(0);
  const total = new Array<number>(targetTimes.length).fill(0);

  for (const sample of samples) {
    if (!Number.isFinite(sample.time) || sample.total <= 0) continue;
    const index = nearestIndex(targetTimes, sample.time);
    lost[index] += sample.lost;
    total[index] += sample.total;
  }

  for (let index = 0; index < targetTimes.length; index += 1) {
    if (total[index] > 0) {
      out[index] = Math.min(100, Math.max(0, (lost[index] / total[index]) * 100));
    }
  }
  return out;
}

/** 丢包百分比：不足 1% 时保留一位小数，否则取整，免得每行都拖着 0.0%。 */
export function formatPingLoss(pct: number) {
  return pct > 0 && pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/**
 * Ping tooltip 里一行的数值。
 *
 * 丢包在前、延迟在后：tooltip 的数值列是右对齐的，把延迟固定放在末尾，
 * 有丢包的那行和没丢包的那行 ms 才落在同一列上。
 * 丢包 0 不写出来，避免每行拖一截噪音；整点全丢时延迟本来就是空的，
 * 这时只报丢包，比一个「—」有用。
 */
export function formatPingTooltipValue(
  latencyMs: number | null,
  lossPct: number | null,
): string {
  const hasLoss = lossPct != null && lossPct > 0;
  if (latencyMs == null) return hasLoss ? `丢包 ${formatPingLoss(lossPct)}` : "—";
  const latency = `${latencyMs.toFixed(1)} ms`;
  return hasLoss ? `丢包 ${formatPingLoss(lossPct)} · ${latency}` : latency;
}

/** 升序数组里离 value 最近的下标。 */
function nearestIndex(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  if (low > 0 && Math.abs(sorted[low - 1] - value) <= Math.abs(sorted[low] - value)) {
    return low - 1;
  }
  return low;
}

/** 长区间图表优先使用实际采样间隔，其次是任务周期。 */
export function resolvePingChartInterval(
  metricIntervalSeconds: number | null | undefined,
  taskIntervalSeconds: number | null | undefined,
  fallbackSeconds = 60,
) {
  for (const value of [metricIntervalSeconds, taskIntervalSeconds, fallbackSeconds]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 60;
}
