import { useEffect, type ReactNode } from "react";
import { useNodeMeta, useNodeMetrics } from "@/hooks/useNode";
import { InstanceSwitcher } from "./InstanceSwitcher";
import {
  formatBytes,
  formatUptimeDays,
} from "@/utils/format";
import { resolveTrafficUsage } from "@/utils/traffic";
import { InstancePanel } from "./InstancePanel";

// Intl.DateTimeFormat 构造开销大，复用一个实例，别每次 metrics 更新都重建
const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function InstanceDetails({
  uuid,
  onNodeReady,
}: {
  uuid: string;
  onNodeReady?: () => (() => void) | void;
}) {
  const meta = useNodeMeta(uuid);
  const metrics = useNodeMetrics(uuid);
  const isReady = Boolean(meta && metrics);

  useEffect(() => {
    if (!isReady) return;
    return onNodeReady?.();
  }, [isReady, onNodeReady, uuid]);

  if (!meta || !metrics) return null;

  const isOnline = metrics.online;
  const uptime = formatUptimeDays(metrics.uptime);
  // 按 traffic_limit_type (max/sum/up/down/min) 归并上下行，和卡片、后端保持一致——
  // 对非 "sum" 节点直接把上下行相加是错的。配额用按周期重置的月度累计值。
  const trafficUsage = resolveTrafficUsage(
    meta.traffic_limit_type,
    metrics.trafficUpMonthly,
    metrics.trafficDownMonthly,
    meta.traffic_limit,
  );
  const lastUpdated =
    metrics.updatedAt > 0 ? TIME_FORMATTER.format(metrics.updatedAt) : "—";
  const trimmedName = meta.name?.trim();
  const panelTitle = trimmedName ? `${trimmedName} 信息` : "实例信息";

  return (
    <InstancePanel
      title={panelTitle}
      titleAction={<InstanceSwitcher currentUuid={uuid} />}
      description={
        isOnline ? undefined : "节点当前离线，以下展示最近一次上报的缓存数据。"
      }
    >
      <div className="instance-info-groups">
        <div className="instance-info-group">
          <div className="instance-info-group-title">系统</div>
          <InfoRow label="状态" value={isOnline ? "在线" : "离线"} />
          <InfoRow
            label="CPU"
            value={`${meta.cpu_name || "—"}${meta.cpu_cores > 0 ? ` (x${meta.cpu_cores})` : ""}`}
          />
          <InfoRow label="架构" value={meta.arch || "—"} />
          <InfoRow label="显卡" value={meta.gpu_name || "—"} />
          <InfoRow label="操作系统" value={meta.os || "—"} />
          {/* 原来这里是「虚拟化」，但 CF-Server-Monitor 不上报该字段(见 toNodeInfo)，
              永远显示「—」。换成后端确实下发、之前一直没用上的内核版本。 */}
          <InfoRow label="内核版本" value={meta.kernel_version || "—"} />
        </div>

        <div className="instance-info-group">
          <div className="instance-info-group-title">资源</div>
          <InfoRow label="内存" value={`${formatBytes(metrics.ramUsed)} / ${formatBytes(metrics.ramTotal)}`} />
          <InfoRow
            label="Swap"
            value={
              metrics.swapTotal > 0
                ? `${formatBytes(metrics.swapUsed)} / ${formatBytes(metrics.swapTotal)}`
                : "无"
            }
          />
          <InfoRow label="磁盘" value={`${formatBytes(metrics.diskUsed)} / ${formatBytes(metrics.diskTotal)}`} />
          <InfoRow
            label="负载"
            value={`${metrics.load1.toFixed(2)} | ${metrics.load5.toFixed(2)} | ${metrics.load15.toFixed(2)}`}
          />
          <InfoRow
            label="运行时长"
            value={uptime.unit ? `${uptime.value} ${uptime.unit}` : uptime.value}
          />
        </div>

        <div className="instance-info-group">
          <div className="instance-info-group-title">网络</div>
          <InfoRow
            label={isOnline ? "实时网络" : "缓存网络"}
            value={`↑ ${formatBytes(metrics.netUp)}/s · ↓ ${formatBytes(metrics.netDown)}/s`}
          />
          <InfoRow label={isOnline ? "最近更新" : "最后上报"} value={lastUpdated} />
          {/* 「今日流量」「峰值速度」已移除：后端没有今日累计字节字段，两者只能由历史瞬时速率
              积分/取极值得出，而历史接口每次固定只返回约 120 个点（区间越长采样越粗），
              数值会随返回的采样点大幅漂移，误导性大于参考价值。 */}
          <div className="instance-info-item is-stack">
            <span className="instance-info-label">总流量</span>
            <div className="instance-info-traffic">
              <span className="instance-info-value">{`↑ ${formatBytes(metrics.trafficUp)} · ↓ ${formatBytes(metrics.trafficDown)}`}</span>
              {meta.traffic_limit > 0 && (
                <>
                  <div className="instance-progress-track" aria-hidden>
                    <span
                      className="instance-progress-fill"
                      style={{ width: `${trafficUsage.fraction * 100}%` }}
                    />
                  </div>
                  <span className="instance-info-note">
                    {`${formatBytes(trafficUsage.used)} / ${formatBytes(meta.traffic_limit)}`}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </InstancePanel>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}) {
  return (
    <div className="instance-info-item">
      <span className="instance-info-label">{label}</span>
      <div className="instance-info-value">{value}</div>
    </div>
  );
}
