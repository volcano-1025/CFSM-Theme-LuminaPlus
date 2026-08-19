import { useEffect, useRef } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import type { PingHealthSummary } from "@/utils/pingWindowHealth";

/**
 * 打开页面时的数据自检弹窗。
 *
 * 只在 {@link usePingDataHealthPrompt} 判定这一屏的延迟数据成色不对时出现，问一句要不要
 * 花一次历史查询把真实采样拉回来。**必须把成本写在脸上** —— 刷新是逐台 `/api/history/all`，
 * 后端按行读 D1，用户有权在点之前知道这次要读多少行。
 */

/** 「哪儿不对」那句话：有什么说什么，别把没观测到的症状写进去。 */
function buildSymptomText(summary: PingHealthSummary): string {
  const base = `已检查的 ${summary.assessed} 台节点里，有 ${summary.gapNodes} 台的延迟柱状图大片空缺`;
  // 复印段是空缺的子集（整段重复的值被丢掉了，才空的），所以写成「其中」。
  return summary.backfilledNodes > 0
    ? `${base}，其中 ${summary.backfilledNodes} 台后端返回的是整段重复的同一个值。`
    : `${base}。`;
}

export function PingHealthDialog({
  summary,
  nodeCount,
  estimatedRows,
  onRefresh,
  onSkip,
}: {
  summary: PingHealthSummary;
  nodeCount: number;
  estimatedRows: number;
  onRefresh: () => void;
  onSkip: () => void;
}) {
  const skipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 默认焦点给「跳过」：这个弹窗是来要钱的，回车不该直接把请求打出去。
    skipRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSkip]);

  return (
    <div className="ping-health-overlay" role="presentation" onClick={onSkip}>
      <div
        className="ping-health-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ping-health-title"
        aria-describedby="ping-health-body"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ping-health-header">
          <span className="ping-health-icon" aria-hidden>
            <AlertTriangle size={16} />
          </span>
          <h2 id="ping-health-title" className="ping-health-title">
            延迟数据看起来不完整
          </h2>
          <button
            type="button"
            className="ping-health-close"
            aria-label="关闭"
            onClick={onSkip}
          >
            <X size={14} />
          </button>
        </div>
        <div id="ping-health-body" className="ping-health-body">
          <p>{buildSymptomText(summary)}</p>
          <p className="ping-health-cost">
            刷新会给每台节点各查一次最近 1 小时的真实采样：
            <strong>{nodeCount} 个请求</strong>，后端约读{" "}
            <strong>{estimatedRows.toLocaleString("zh-CN")} 行 D1</strong>。
            不刷新也不影响使用，页面会继续按实时推送自己攒数据。
          </p>
        </div>
        <div className="ping-health-actions">
          <button
            type="button"
            ref={skipRef}
            className="ping-health-button is-skip"
            onClick={onSkip}
          >
            跳过
          </button>
          <button
            type="button"
            className="ping-health-button is-refresh"
            onClick={onRefresh}
          >
            <RefreshCw size={14} />
            刷新（{nodeCount} 台）
          </button>
        </div>
      </div>
    </div>
  );
}
