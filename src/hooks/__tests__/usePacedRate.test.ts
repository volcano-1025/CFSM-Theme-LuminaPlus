import { describe, expect, it } from "vitest";
import { resolvePacedEmitDelay } from "@/hooks/usePacedRate";

const INTERVAL = 1_000;

describe("resolvePacedEmitDelay", () => {
  it("shows the very first value immediately", () => {
    // 首屏第一个到的节点不能等满一拍，否则顶部先干挂一秒的 0。
    expect(resolvePacedEmitDelay(0, 5_000, INTERVAL)).toBe(0);
  });

  it("holds a change that lands inside the interval until the interval is up", () => {
    // 站长要的口径：相邻两次换值至少隔 1 秒。
    expect(resolvePacedEmitDelay(5_000, 5_200, INTERVAL)).toBe(800);
    expect(resolvePacedEmitDelay(5_000, 5_999, INTERVAL)).toBe(1);
  });

  it("lets a change through once the interval has elapsed", () => {
    expect(resolvePacedEmitDelay(5_000, 6_000, INTERVAL)).toBe(0);
    expect(resolvePacedEmitDelay(5_000, 9_000, INTERVAL)).toBe(0);
  });

  it("never asks to wait longer than one interval", () => {
    // 时钟被往回拨也不能把显示卡住超过一拍。
    expect(resolvePacedEmitDelay(5_000, 4_000, INTERVAL)).toBeLessThanOrEqual(INTERVAL);
  });

  it("follows a custom interval", () => {
    expect(resolvePacedEmitDelay(5_000, 5_500, 2_000)).toBe(1_500);
    expect(resolvePacedEmitDelay(5_000, 7_000, 2_000)).toBe(0);
  });
});
