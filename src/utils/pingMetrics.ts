import type { PingRecord } from "@/types/cfsm";

/**
 * 把一条 Ping 样本还原成"总数/丢失/有效"三元组。
 *
 * CF-Server-Monitor 的历史每行只有一次探测结果，`count` 恒为 1；`loss` 是该次采样的
 * 丢包百分比。`value < 0` 视为整点丢失。
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
      ? Math.min(total, Math.max(0, Math.round((reportedLoss / 100) * total)))
      : sample.value < 0
        ? total
        : 0;
  return { total, lost, valid: total - lost };
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
