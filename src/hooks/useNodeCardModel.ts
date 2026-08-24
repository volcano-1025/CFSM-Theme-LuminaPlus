import { useMemo } from "react";
import { useFakePingFallback } from "@/hooks/useFakePing";
import { useHourlyClock, useMinuteClock } from "@/hooks/useClock";
import { useNodeCardSnapshots, useShowThreeNetDetails } from "@/hooks/useNode";
import {
  buildPingBuckets,
  useNodePingOverview,
  useNodePingOverviewLines,
  usePingBuckets,
  useSelectedTaskId,
  withLiveLatency,
} from "@/hooks/usePingOverview";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { useLatencyWindowMs } from "@/hooks/usePublicConfig";
import type { HomepagePingDisplayLine, HomepagePingLine } from "@/types/cfsm";
import { formatRenewalPrice } from "@/utils/billing";
import { getExpireTextColor } from "@/utils/expireStatus";
import {
  formatBytes,
  formatByteRate,
  formatExpireDays,
  formatUptimeDays,
  joinDisplayParts,
  parseTags,
} from "@/utils/format";
import {
  latencyHeatColor,
  lossHeatColor,
  trafficUsageColor,
} from "@/utils/metricTone";
import { resolveTrafficUsage, trafficTypeLabel, type TrafficDisplay } from "@/utils/traffic";
import { resolveOsInfo } from "@/components/ui/OsLogo";
import {
  hasHomepagePingTaskBinding,
  HOMEPAGE_MULTI_PING_TASK_COUNT,
} from "@/utils/pingTasks";

interface NodeCardModelOptions {
  pingBucketCount?: number;
  includeMultiPing?: boolean;
}

export function shouldRenderHomepagePingBars(
  hasRealHomepagePingBinding: boolean,
  pingIsAssigned: boolean,
) {
  return hasRealHomepagePingBinding || pingIsAssigned;
}

export function useNodeCardModel(
  uuid: string,
  {
    pingBucketCount,
    includeMultiPing = false,
  }: NodeCardModelOptions = {},
) {
  const { meta, metrics, trafficTrend } = useNodeCardSnapshots(uuid);
  const {
    showCardGroup,
    showCardPrice,
    fakePingForUnbound,
    homepagePingBindings,
    enableHomepageMultiPing,
    homepageMultiPingTaskIds,
  } = useThemeSettings();
  // 后端关掉「输出首页详细 ping/loss」时那三条线一条数据都没有，直接回退单线路，
  // 免得画出三条空线（口径见 useShowThreeNetDetails）。
  const showThreeNetDetails = useShowThreeNetDetails();
  const multiPingActive =
    includeMultiPing &&
    showThreeNetDetails &&
    enableHomepageMultiPing &&
    homepageMultiPingTaskIds.length === HOMEPAGE_MULTI_PING_TASK_COUNT;
  const windowPing = useNodePingOverview(uuid, !multiPingActive);
  const windowPingLines = useNodePingOverviewLines(uuid, multiPingActive);
  // 柱子来自后端窗口，数字用 WS 的实时值补一下 —— 理由见 `withLiveLatency`。
  // `metrics.ping` 在值没变时会沿用同一个对象，可以直接进依赖数组。
  const livePing = metrics?.online === true ? metrics.ping : null;
  const selectedTaskId = useSelectedTaskId(uuid);
  const realPing = useMemo(
    () => withLiveLatency(windowPing, livePing, selectedTaskId),
    [livePing, selectedTaskId, windowPing],
  );
  const realPingLines = useMemo<HomepagePingLine[]>(
    () =>
      windowPingLines.map((line) => ({
        ...withLiveLatency(line, livePing, line.taskId),
        taskId: line.taskId,
        taskName: line.taskName,
      })),
    [livePing, windowPingLines],
  );
  const hasRealHomepagePingBinding = useMemo(
    () =>
      multiPingActive || hasHomepagePingTaskBinding(uuid, homepagePingBindings),
    [homepagePingBindings, multiPingActive, uuid],
  );
  const now = useHourlyClock();
  const ping = useFakePingFallback(
    uuid,
    realPing,
    metrics?.online === true,
    fakePingForUnbound && !multiPingActive,
    homepagePingBindings,
  );
  // 状态跟随每条任务数据进入 Store,不再订阅全局 isRefreshing。这样后台轮询开始/结束
  // 时不会让所有节点卡片仅因一个布尔值变化而重渲染。
  const pingLoading =
    hasRealHomepagePingBinding && (ping.loadState ?? "pending") === "pending";
  const pingError =
    hasRealHomepagePingBinding && ping.loadState === "error";
  const shouldRenderPingBars = shouldRenderHomepagePingBars(
    hasRealHomepagePingBinding,
    ping.isAssigned,
  );
  // 掉线后延迟/丢包柱按最后一次上报截断，之后的格子涂红。用 `updatedAt` 而不是
  // 「发现掉线的时刻」：前者是节点真正停止上报的时间，红色从那里开始才对得上。
  const offlineSince =
    metrics && metrics.online === false && metrics.updatedAt > 0
      ? metrics.updatedAt
      : null;
  // 后端下发 latency_window.hours 时用它定柱子跨度；缺席就传 undefined，回退到
  // buildPingBuckets 的「从数据自推跨度」。四种视图都走这里，口径统一。
  const latencyWindowMs = useLatencyWindowMs();
  const pingBuckets = usePingBuckets(
    ping,
    pingBucketCount,
    !multiPingActive,
    offlineSince,
    latencyWindowMs,
  );
  // 与 usePingBuckets 同理:窗口按分钟前移,不依赖数据刷新才滑动。
  const bucketNow = useMinuteClock(multiPingActive);
  const homepagePingLines = useMemo<HomepagePingDisplayLine[]>(() => {
    if (
      !multiPingActive
    ) {
      return [];
    }
    return homepageMultiPingTaskIds.map((taskId) => {
      const loaded = realPingLines.find((line) => line.taskId === taskId);
      const line: HomepagePingLine =
        loaded ?? {
          taskId,
          taskName: `任务 #${taskId}`,
          client: uuid,
          isAssigned: true,
          loadState: "pending",
          lastValue: null,
          samples: [],
          max: 1,
          loss: null,
        };
      return {
        ...line,
        buckets: buildPingBuckets(
          line,
          pingBucketCount,
          bucketNow,
          offlineSince,
          latencyWindowMs,
        ),
      };
    });
  }, [
    bucketNow,
    homepageMultiPingTaskIds,
    latencyWindowMs,
    multiPingActive,
    offlineSince,
    pingBucketCount,
    realPingLines,
    uuid,
  ]);

  const metaModel = useMemo(() => {
    if (!meta) return null;
    const tags = parseTags(meta.tags);
    const group = showCardGroup ? meta.group : undefined;
    const subtitleParts = [group, meta.public_remark]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part));
    const subtitleLabels = new Set(subtitleParts.map((part) => part.toLowerCase()));
    const compactFooterTags = tags.filter(
      (tag) => !subtitleLabels.has(tag.label.trim().toLowerCase()),
    );
    const fallbackFooterTags =
      tags.length > 0
        ? tags
        : group
          ? [{ label: group, color: "gray" }]
          : [];
    return {
      tags,
      footerTags: fallbackFooterTags,
      compactFooterTags,
      subtitle: joinDisplayParts(subtitleParts),
      expire: formatExpireDays(meta.expired_at, now),
      expireColor: getExpireTextColor(meta.expired_at, now),
      // 「卡片显示价格」只作用于大卡片（NodeCard 自己收敛）；小卡片等布局照旧显示，
      // 未填价格显示「免费」。
      showCardPrice,
      renewalPrice: formatRenewalPrice(meta),
      osName: resolveOsInfo(meta.os).name,
      loadBaseline: meta.cpu_cores > 0 ? meta.cpu_cores : 4,
    };
  }, [meta, now, showCardGroup, showCardPrice]);

  // ping 派生的颜色只在 ping item 变化时才变。
  const pingModel = useMemo(
    () => ({
      latencyColor: latencyHeatColor(ping.lastValue),
      lossColor: lossHeatColor(ping.loss),
      hasRealHomepagePingBinding,
      // 保留旧字段供外部模型消费者兼容；它表示真实配置状态。
      hasHomepagePingBinding: hasRealHomepagePingBinding,
      shouldRenderPingBars,
      pingLoading,
      pingError,
    }),
    [
      hasRealHomepagePingBinding,
      ping,
      pingError,
      pingLoading,
      shouldRenderPingBars,
    ],
  );

  return useMemo(() => {
    if (!meta || !metrics || !metaModel) {
      return {
        node: undefined,
        trafficTrend,
        ping,
        pingBuckets,
        homepagePingLines,
      };
    }

    const { loadBaseline } = metaModel;

    // 流量配额：按节点的 traffic_limit_type（与后端一致）把上/下行算成"已用"，
    // 在这里一次性算出剩余和使用占比，让两种卡片布局共用这套计算。
    // 配额是按计费周期重置的，必须用月度累计值，而不是探针生命周期的总量。
    const trafficUsage = resolveTrafficUsage(
      meta.traffic_limit_type,
      metrics.trafficUpMonthly,
      metrics.trafficDownMonthly,
      meta.traffic_limit,
    );
    const trafficUsedLabel = formatBytes(trafficUsage.used);
    // 不限量时渲染成 ∞，让剩余值和"已用/上限"那行与限量情况保持一致
    //（"剩余 ∞" + "2.73 GB / ∞"）。
    const trafficLimitLabel = trafficUsage.unlimited ? "∞" : formatBytes(trafficUsage.limit);
    const trafficColor = trafficUsage.unlimited
      ? "var(--status-success)"
      : trafficUsageColor(trafficUsage.fraction);
    const traffic: TrafficDisplay = {
      fraction: trafficUsage.fraction,
      color: trafficColor,
      remainingLabel: trafficUsage.unlimited ? "∞" : formatBytes(trafficUsage.remaining),
      detail: `${trafficUsedLabel} / ${trafficLimitLabel}`,
      typeLabel: trafficTypeLabel(meta.traffic_limit_type),
    };

    return {
      node: { ...meta, ...metrics },
      trafficTrend,
      ping,
      pingBuckets,
      homepagePingLines,
      traffic,
      ...metaModel,
      ...pingModel,
      uptime: formatUptimeDays(metrics.uptime),
      loadFraction: Math.max(0, Math.min(1, metrics.load1 / loadBaseline)),
      upRate: formatByteRate(metrics.netUp),
      downRate: formatByteRate(metrics.netDown),
      isOnline: metrics.online === true,
      isOffline: metrics.online === false,
    };
  }, [
    homepagePingLines,
    meta,
    metrics,
    metaModel,
    pingModel,
    ping,
    pingBuckets,
    trafficTrend,
  ]);
}
