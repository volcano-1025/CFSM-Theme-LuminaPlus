// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type uPlot from "uplot";
import { buildChartTooltipHooks } from "../chartShared";

/**
 * uPlot 只绑鼠标事件，触屏上辅助线拖不动。这里验证 touch 事件确实被翻成了 setCursor。
 * jsdom 没有 TouchEvent 构造器，用带 touches 的普通 Event 冒充即可 —— 处理器只读
 * `touches[0].clientX/clientY`。
 */
function touchEvent(type: string, clientX: number, clientY: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: [{ clientX, clientY }],
  });
  return event;
}

function fakePlot(setCursor: (position: { left: number; top: number }) => void) {
  const over = document.createElement("div");
  over.getBoundingClientRect = () =>
    ({ left: 40, top: 100, width: 300, height: 200 }) as DOMRect;
  const root = document.createElement("div");
  root.append(over);
  document.body.append(root);
  return { over, root, setCursor } as unknown as uPlot;
}

function hooks() {
  return buildChartTooltipHooks({
    dataRef: { current: [[]] as unknown as uPlot.AlignedData },
    rangeHours: 1,
    estimatedWidth: 196,
    setTooltip: () => undefined,
    buildRows: () => [],
  });
}

describe("触屏拖动辅助线", () => {
  it("把 touchstart / touchmove 翻成 setCursor 的画布内坐标", () => {
    const setCursor = vi.fn();
    const u = fakePlot(setCursor);
    hooks().onInit(u);

    u.over.dispatchEvent(touchEvent("touchstart", 100, 180));
    expect(setCursor).toHaveBeenLastCalledWith({ left: 60, top: 80 });

    u.over.dispatchEvent(touchEvent("touchmove", 260, 150));
    expect(setCursor).toHaveBeenLastCalledWith({ left: 220, top: 50 });
  });

  it("手指划出画布时把游标夹在边界上，而不是给出负数", () => {
    const setCursor = vi.fn();
    const u = fakePlot(setCursor);
    hooks().onInit(u);

    u.over.dispatchEvent(touchEvent("touchmove", -50, 900));
    expect(setCursor).toHaveBeenLastCalledWith({ left: 0, top: 200 });
  });

  it("销毁后不再响应触摸", () => {
    const setCursor = vi.fn();
    const u = fakePlot(setCursor);
    const chartHooks = hooks();
    chartHooks.onInit(u);
    chartHooks.onDestroy(u);

    u.over.dispatchEvent(touchEvent("touchmove", 100, 180));
    expect(setCursor).not.toHaveBeenCalled();
  });
});
