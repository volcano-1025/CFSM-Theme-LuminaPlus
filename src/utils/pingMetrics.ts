import { t } from "@/i18n";
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
 * 归到哪一格由 `resolveIndex` 说了算：Ping 图传的是折线降采样时每个原始时刻落进的那一格，色带和折线才是同一套分桶。
 * 不传（或它答不上来）才退回「就近归入最接近的目标时刻」。**只靠就近不行**：降采样后每格的时刻是格内样本时间的平均、不是桶心，
 * 行距不匀时（站长站点 6 小时档是 60 秒、120 秒交替）一格里的两个样本会分别被左右两格「抢走」，这一格落空，
 * 色带上就多出一段没有数据的缺口，其实历史一行没少（2026-11-12 站长截图，Oracle-sjc 6 小时档复现出 2 格）。
 * 返回值与 targetTimes 等长：该格没有任何样本时是 null（无数据），有样本才是百分比。
 */
export function bucketPingLoss(
  samples: PingLossSample[],
  targetTimes: number[],
  resolveIndex?: (time: number) => number | undefined,
): Array<number | null> {
  const out = new Array<number | null>(targetTimes.length).fill(null);
  if (targetTimes.length === 0 || samples.length === 0) return out;

  const lost = new Array<number>(targetTimes.length).fill(0);
  const total = new Array<number>(targetTimes.length).fill(0);

  for (const sample of samples) {
    if (!Number.isFinite(sample.time) || sample.total <= 0) continue;
    const resolved = resolveIndex?.(sample.time);
    const index =
      resolved != null && resolved >= 0 && resolved < targetTimes.length
        ? resolved
        : nearestIndex(targetTimes, sample.time);
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

/**
 * 丢包色带上每一格在时间轴上占的范围 `[起, 止]`；没有采样的格是 null。
 *
 * 相邻两格都有数据时各占到中点，中间不留缝。**旁边那格没数据（断档、数组两端）时最多只占半个常规点距**：
 * 原来一律占到中点，节点断了两个多小时再恢复，恢复后第一格会往回涂满断档的后一半 —— 站长 2026-10-10 截图：
 * 18:16 到 20:36 没有数据，色带却从 19:30 左右就是绿的，下面折线 20:38 才开始。
 */
export function resolveLossCellSpans(
  times: number[],
  loss: Array<number | null>,
): Array<[number, number] | null> {
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index] - times[index - 1];
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((left, right) => left - right);
  // 取偏小的那个中位数：只有两三个间隔、其中一个是断档时，别让断档本身成了「常规点距」。
  const half = (gaps[Math.floor((gaps.length - 1) / 2)] ?? 0) / 2;

  const reach = (time: number, neighbor: number | undefined, neighborHasData: boolean) => {
    if (neighbor == null) return half;
    const toMidpoint = Math.abs(neighbor - time) / 2;
    return neighborHasData ? toMidpoint : Math.min(toMidpoint, half);
  };

  return times.map((time, index) => {
    if (loss[index] == null) return null;
    return [
      time - reach(time, times[index - 1], loss[index - 1] != null),
      time + reach(time, times[index + 1], loss[index + 1] != null),
    ];
  });
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
  if (latencyMs == null) return hasLoss ? t("ping.lossValue", { value: formatPingLoss(lossPct) }) : "—";
  const latency = `${latencyMs.toFixed(1)} ms`;
  return hasLoss ? `${t("ping.lossValue", { value: formatPingLoss(lossPct) })} · ${latency}` : latency;
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
