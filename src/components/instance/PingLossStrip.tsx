import { useEffect, useRef } from "react";
import { lossHeatColor } from "@/utils/metricTone";

/**
 * Ping 图下方的丢包色带。
 *
 * 放在折线图上方，每条线路一行，横轴与主图严格对齐：整条色带的宽度直接取主图 canvas 的宽度（而不是
 * 自己量容器 —— 图表宽度会被量化到 8px 网格，量容器会差几像素），左边留出与 Y 轴刻度
 * 同宽的槽位放线路名，右边留出与主图相同的内边距，时间→像素用主图同一个 x 区间换算。
 *
 * 色阶与首页卡片、迷你卡共用 lossHeatColor（0% 绿 → 20%+ 红）。
 * 没有采样的时段不画，露出底色轨道 —— 掉线和「丢包 0%」必须看得出区别。
 */

const ROW_HEIGHT = 6;

export interface PingLossRow {
  id: number;
  label: string;
  /** 与 times 等长；null = 该时段没有采样。 */
  loss: Array<number | null>;
}

export function PingLossStrip({
  times,
  xRange,
  rows,
  chartWidth,
  gutter,
  rightPad,
  isDark,
  cursorLeft,
}: {
  times: number[];
  xRange: [number, number] | null;
  rows: PingLossRow[];
  chartWidth: number;
  gutter: number;
  rightPad: number;
  isDark: boolean;
  /** 主图游标距绘图区左边的像素；null 表示鼠标不在图上。 */
  cursorLeft: number | null;
}) {
  const trackWidth = Math.max(0, chartWidth - gutter - rightPad);
  if (rows.length === 0 || times.length === 0 || trackWidth <= 0) return null;

  return (
    <div className="ping-loss-strip" style={{ width: chartWidth }}>
      {/* 游标竖线：色带与绘图区左边界、宽度都一致，所以直接用主图的 cursor.left */}
      {cursorLeft != null && cursorLeft <= trackWidth && (
        <div className="ping-loss-cursor" style={{ left: gutter + cursorLeft }} aria-hidden />
      )}
      {rows.map((row) => (
        <div className="ping-loss-row" key={row.id}>
          <span className="ping-loss-label" style={{ width: gutter }}>
            {row.label}
          </span>
          <LossRowCanvas
            times={times}
            loss={row.loss}
            xRange={xRange}
            width={trackWidth}
            isDark={isDark}
            label={row.label}
          />
        </div>
      ))}
    </div>
  );
}

function LossRowCanvas({
  times,
  loss,
  xRange,
  width,
  isDark,
  label,
}: {
  times: number[];
  loss: Array<number | null>;
  xRange: [number, number] | null;
  width: number;
  isDark: boolean;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(ROW_HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, ROW_HEIGHT);

    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(0, 0, width, ROW_HEIGHT, ROW_HEIGHT / 2);
    } else {
      ctx.rect(0, 0, width, ROW_HEIGHT);
    }
    ctx.clip();

    // 轨道底色：没有采样的时段就露出它，和「丢包 0%」的绿块区分开。
    ctx.fillStyle = isDark ? "rgba(255, 255, 255, 0.07)" : "rgba(24, 24, 27, 0.07)";
    ctx.fillRect(0, 0, width, ROW_HEIGHT);

    const [t0, t1] = xRange ?? [times[0], times[times.length - 1]];
    const span = t1 - t0;
    if (!(span > 0)) {
      const only = loss.find((value) => value != null);
      if (only != null) {
        ctx.fillStyle = lossHeatColor(only);
        ctx.fillRect(0, 0, width, ROW_HEIGHT);
      }
      return;
    }
    const toX = (time: number) => ((time - t0) / span) * width;

    for (let index = 0; index < times.length; index += 1) {
      const value = loss[index];
      if (value == null) continue;
      // 每格覆盖到与前后邻点的中点，相邻格之间不留缝。
      const prev = times[index - 1] ?? times[index] - (times[index + 1] - times[index] || 0);
      const next = times[index + 1] ?? times[index] + (times[index] - times[index - 1] || 0);
      const left = Math.max(0, toX((prev + times[index]) / 2));
      const right = Math.min(width, toX((times[index] + next) / 2));
      const barWidth = Math.max(1, right - left);
      if (right <= 0 || left >= width) continue;
      ctx.fillStyle = lossHeatColor(value);
      ctx.fillRect(left, 0, barWidth, ROW_HEIGHT);
    }
  }, [isDark, loss, times, width, xRange]);

  const measured = loss.filter((value): value is number => value != null);
  const average =
    measured.length > 0
      ? measured.reduce((sum, value) => sum + value, 0) / measured.length
      : null;

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`${label} 丢包${average == null ? "无数据" : ` 平均 ${average.toFixed(1)}%`}`}
      style={{ width, height: ROW_HEIGHT }}
    />
  );
}
