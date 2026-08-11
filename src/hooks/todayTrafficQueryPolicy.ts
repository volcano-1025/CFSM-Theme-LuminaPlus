const HOUR_MS = 60 * 60 * 1000;
const TRAFFIC_STATS_REFRESH_MS = 5 * 60 * 1000;
const TRAFFIC_STATS_ERROR_RETRY_MS = 60 * 1000;

/** `/api/history/all` 支持的时长档位。 */
const HISTORY_HOURS_STEPS = [1, 6, 12, 24, 48] as const;

export function selectActiveTodayTrafficUuids(
  uuids: string[],
  activeUuids: ReadonlySet<string>,
) {
  return [...new Set(uuids.filter((uuid) => activeUuids.has(uuid)))];
}

/**
 * 今日流量由速率采样积分得到，需要覆盖午夜前的一个采样点作为时间基准，
 * 同时时长必须落在后端支持的档位上。
 */
export function getTodayTrafficRecordRangeHours(startMs: number, endMs: number) {
  const elapsedHours = Math.max(1, Math.ceil((endMs - startMs) / HOUR_MS) + 1);
  return HISTORY_HOURS_STEPS.find((hours) => hours >= elapsedHours) ?? 48;
}

export function getTodayTrafficRefreshInterval(
  source: "records" | undefined,
  hasError: boolean,
) {
  if (hasError) return TRAFFIC_STATS_ERROR_RETRY_MS;
  return source == null ? false : TRAFFIC_STATS_REFRESH_MS;
}
