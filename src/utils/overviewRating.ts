export type OverviewRatingKind = "traffic" | "bandwidth" | "asset";

export interface OverviewRating {
  level: 0 | 1 | 2 | 3;
  label: string;
}

const GB = 1024 ** 3;
const MBPS_IN_BYTES_PER_SECOND = 1_000_000 / 8;

const DEFAULT_LABELS: Record<OverviewRatingKind, readonly string[]> = {
  traffic: ["轻量", "常规", "重度", "海量"],
  bandwidth: ["闲置", "轻载", "活跃", "爆发"],
  asset: ["入门", "标准", "顶级", "富佬"],
};

export function getDefaultOverviewRatingLabelText(kind: OverviewRatingKind) {
  return DEFAULT_LABELS[kind].join(",");
}

export function normalizeOverviewRatingLabels(
  kind: OverviewRatingKind,
  customLabels: string | null | undefined,
) {
  const fallback = DEFAULT_LABELS[kind];
  const custom = String(customLabels ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 4);

  return fallback.map((label, index) => custom[index] ?? label);
}

function levelFromThresholds(value: number, thresholds: readonly [number, number, number]): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(value) || value <= thresholds[0]) return 0;
  if (value <= thresholds[1]) return 1;
  if (value <= thresholds[2]) return 2;
  return 3;
}

export function getOverviewRating({
  kind,
  value,
  customLabels,
}: {
  kind: OverviewRatingKind;
  value: number;
  customLabels?: string | null;
}): OverviewRating {
  const labels = normalizeOverviewRatingLabels(kind, customLabels);
  const level =
    kind === "asset"
      ? levelFromThresholds(value, [500, 1500, 3000])
      : kind === "traffic"
        ? levelFromThresholds(value, [500 * GB, 2000 * GB, 10000 * GB])
        : levelFromThresholds(value, [
            1 * MBPS_IN_BYTES_PER_SECOND,
            10 * MBPS_IN_BYTES_PER_SECOND,
            100 * MBPS_IN_BYTES_PER_SECOND,
          ]);

  return {
    level,
    label: labels[level],
  };
}
