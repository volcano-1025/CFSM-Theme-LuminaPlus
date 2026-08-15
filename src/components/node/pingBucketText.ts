import type { PingOverviewBucket } from "@/types/cfsm";
import { trimFixed } from "@/utils/format";

function formatPingBucketWindow(bucket: PingOverviewBucket | null) {
  if (!bucket || bucket.startAt == null || bucket.endAt == null) {
    return null;
  }

  const start = new Date(bucket.startAt);
  const end = new Date(bucket.endAt);
  const startText = `${start.getHours().toString().padStart(2, "0")}:${start
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
  const endText = `${end.getHours().toString().padStart(2, "0")}:${end
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
  return `${startText} - ${endText}`;
}

function formatLatencyBucketSummary(bucket: PingOverviewBucket | null) {
  if (!bucket) return "—";
  // 掉线要和「探测没跑到」区分开：前者是节点整台没了，后者只是这一格没样本。
  if (bucket.offline) return "离线";
  if (bucket.value != null) return `${trimFixed(bucket.value, 1)} ms`;
  return bucket.total > 0 ? "失败" : "无样本";
}

function formatLossBucketSummary(
  bucket: PingOverviewBucket | null,
  separator = " ",
) {
  if (!bucket) return "—";
  if (bucket.offline) return "离线";
  if (bucket.total <= 0 || bucket.loss == null) return "无样本";
  // 后端每个采样点给的是丢包百分比而不是"丢了几个包"，写成 x/y 会误导，
  // 这里只显示百分比与参与聚合的采样点数。
  const count = Math.max(1, Math.round(bucket.total));
  return `${trimFixed(bucket.loss, 1)}%${separator}${count} 次采样`;
}

export function formatHealthBucketTooltip(
  bucket: PingOverviewBucket,
  kind: "latency" | "loss",
) {
  const window = formatPingBucketWindow(bucket);
  const summary =
    kind === "latency"
      ? formatLatencyBucketSummary(bucket)
      : formatLossBucketSummary(bucket, " · ");
  return window ? `${window} · ${summary}` : summary;
}
