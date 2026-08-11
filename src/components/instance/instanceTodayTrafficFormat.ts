import { formatByteRateLabel, formatBytes, formatClockTime } from "@/utils/format";
import type { TodayTrafficStat } from "@/utils/trafficStats";

export function formatTodayTrafficValue(
  stat: TodayTrafficStat | undefined,
  pending: boolean,
  isError: boolean,
): string {
  if (isError && !stat) return "今日流量加载失败";
  if (pending && !stat) return "—";
  if (isError) {
    if (!stat || !stat.hasSamples) return "今日暂无采样（更新失败）";
    return `↑ ${formatBytes(stat.trafficUp)} · ↓ ${formatBytes(stat.trafficDown)}（更新失败）`;
  }
  if (!stat || !stat.hasSamples) return "今日暂无采样";
  return `↑ ${formatBytes(stat.trafficUp)} · ↓ ${formatBytes(stat.trafficDown)}`;
}

export function formatTodayPeakValue(
  stat: TodayTrafficStat | undefined,
  pending: boolean,
): string {
  if (pending && !stat) return "—";
  if (!stat || !stat.hasSamples) return "—";
  const upTime =
    stat.peakUp > 0 && stat.peakUpAt != null
      ? `（${formatClockTime(stat.peakUpAt)}）`
      : "";
  const downTime =
    stat.peakDown > 0 && stat.peakDownAt != null
      ? `（${formatClockTime(stat.peakDownAt)}）`
      : "";
  return `↑ ${formatByteRateLabel(stat.peakUp)}${upTime} · ↓ ${formatByteRateLabel(stat.peakDown)}${downTime}`;
}
