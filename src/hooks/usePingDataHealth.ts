import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildPingBuckets, buildPingOverviewItem } from "@/hooks/usePingOverview";
import { useVisibleNodeUuids } from "@/hooks/useNode";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { readLastPingRefreshAt, shouldRemindRecentRefresh } from "@/hooks/usePingHistoryRefresh";
import { getPingHistorySnapshot, getPingWindowStats } from "@/services/pingLiveStore";
import { getNodeMetaSnapshot, getNodeMetricsSnapshot } from "@/services/wsStore";
import {
  assessNodePingHealth,
  estimateRefreshRowCount,
  HEALTH_BUCKET_COUNT,
  shouldPromptPingRefresh,
  summarizePingHealth,
  type NodePingHealth,
  type PingHealthSummary,
} from "@/utils/pingWindowHealth";
import {
  DEFAULT_HOMEPAGE_PING_TASK_ID,
  HOMEPAGE_MULTI_PING_TASK_COUNT,
  invertHomepagePingTaskBindings,
} from "@/utils/pingTasks";

/**
 * 打开页面时自检一次首页的延迟数据，成色不对就问用户要不要刷。
 *
 * **只在页面加载后跑一次**，不挂定时器、不挂可见性变化 —— 那会变成变相的自动查历史，
 * 正是硬约束禁止的那种用法（见 CLAUDE.md）。自检本身一个请求都不发，只看已经拿到的
 * `/api/servers` 窗口和本地缓冲；真要补数据是用户在弹窗里点「刷新」之后的事。
 */

/**
 * 等这么久再判。
 *
 * 判定要读的是 `/api/servers` 那份窗口 —— store 报 hydrated 时首屏数据已经进来了，
 * 但 WS 还在连、localStorage 里的本地样本也刚灌进缓冲，早判会把「还没合并完」当成空缺。
 */
const ASSESS_DELAY_MS = 2_500;

/**
 * 自检结果按「一次页面加载」记，模块级变量正好是这个生命周期：
 * 从详情页返回首页会重新挂载组件，但不该再问一次；F5 或重新打开标签页则该再问。
 */
let promptedThisLoad = false;

/** 测试用：清掉「这次加载已经问过了」的标记。 */
export function resetPingDataHealthPrompt(): void {
  promptedThisLoad = false;
}

export interface PingDataHealthPrompt {
  /** 非 null 时该弹窗；里面是「哪儿不对」的统计。 */
  summary: PingHealthSummary | null;
  /** 刷新会逐台发请求，这是台数。 */
  nodeCount: number;
  /** 这次刷新大概让后端读多少行 D1。 */
  estimatedRows: number;
  dismiss: () => void;
}

/** 一台节点在卡片上实际画出来的格子：多线路时取最完整的那条。 */
function resolveNodeBuckets(uuid: string, taskIds: readonly number[], now: number) {
  const samples = getPingHistorySnapshot(uuid);
  const metrics = getNodeMetricsSnapshot(uuid);
  // 口径和卡片一致：掉线之后的格子涂红，不算「空缺」。
  const offlineSince =
    metrics && metrics.online === false && metrics.updatedAt > 0 ? metrics.updatedAt : null;

  let best: ReturnType<typeof buildPingBuckets> | null = null;
  let bestFilled = -1;
  for (const taskId of taskIds) {
    const item = buildPingOverviewItem(uuid, taskId, samples);
    // 这条线路一个实测值都没有：多半是这个探测任务没跑，不能拿它当「空缺」的证据。
    if (!item.isAssigned) continue;
    const buckets = buildPingBuckets(item, HEALTH_BUCKET_COUNT, now, offlineSince);
    const filled = buckets.filter((bucket) => !bucket.offline && bucket.value != null).length;
    if (filled > bestFilled) {
      bestFilled = filled;
      best = buckets;
    }
  }
  return { buckets: best, offlineSince };
}

/** 逐台判定。导出是为了单测能直接喂 store 里的数据。 */
export function collectPingHealth(
  uuids: readonly string[],
  resolveTaskIds: (uuid: string) => number[],
  now = Date.now(),
): (NodePingHealth | null)[] {
  return uuids.map((uuid) => {
    const { buckets, offlineSince } = resolveNodeBuckets(uuid, resolveTaskIds(uuid), now);
    const stats = getPingWindowStats(uuid);
    return assessNodePingHealth(
      {
        uuid,
        buckets,
        windowSlots: stats?.slots ?? 0,
        droppedSlots: stats?.dropped ?? 0,
        offlineSince,
      },
      now,
    );
  });
}

export function usePingDataHealthPrompt(enabled: boolean): PingDataHealthPrompt {
  const uuids = useVisibleNodeUuids();
  const { homepagePingBindings, enableHomepageMultiPing, homepageMultiPingTaskIds } =
    useThemeSettings();
  const [summary, setSummary] = useState<PingHealthSummary | null>(null);
  const uuidsRef = useRef(uuids);
  uuidsRef.current = uuids;

  const multiActive =
    enableHomepageMultiPing &&
    homepageMultiPingTaskIds.length === HOMEPAGE_MULTI_PING_TASK_COUNT;
  const resolveTaskIds = useCallback(
    (uuid: string): number[] => {
      if (multiActive) return homepageMultiPingTaskIds;
      const byClient = invertHomepagePingTaskBindings(homepagePingBindings);
      return [byClient.get(uuid) ?? DEFAULT_HOMEPAGE_PING_TASK_ID];
    },
    [homepagePingBindings, homepageMultiPingTaskIds, multiActive],
  );
  const resolveTaskIdsRef = useRef(resolveTaskIds);
  resolveTaskIdsRef.current = resolveTaskIds;

  useEffect(() => {
    if (!enabled || promptedThisLoad || uuids.length === 0) return;

    const timer = setTimeout(() => {
      if (promptedThisLoad) return;
      promptedThisLoad = true;
      const now = Date.now();
      // 半小时内刚刷过就别问了：那会儿的数据已经是花过 D1 换来的，还空着说明历史表里
      // 本来就没有，再刷一次只是白读一遍。口径与刷新按钮的重复点击提醒共用。
      if (shouldRemindRecentRefresh(readLastPingRefreshAt(), now)) return;

      const results = collectPingHealth(uuidsRef.current, resolveTaskIdsRef.current, now);
      const next = summarizePingHealth(results);
      if (shouldPromptPingRefresh(next)) setSummary(next);
    }, ASSESS_DELAY_MS);

    return () => clearTimeout(timer);
  }, [enabled, uuids.length]);

  const estimatedRows = useMemo(() => {
    if (summary == null) return 0;
    return estimateRefreshRowCount(
      uuids.map((uuid) => getNodeMetaSnapshot(uuid)?.report_interval ?? 0),
    );
  }, [summary, uuids]);

  const dismiss = useCallback(() => setSummary(null), []);

  return { summary, nodeCount: uuids.length, estimatedRows, dismiss };
}
