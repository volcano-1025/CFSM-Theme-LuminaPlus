import { describe, expect, it } from "vitest";
import {
  resolveTouchBucketIndex,
  TOUCH_BUCKET_HOLD_MS,
} from "@/components/node/touchBucketPick";

const rect = { left: 100, width: 180 };

describe("触屏点选延迟柱子", () => {
  it("按整条宽度均分：手指落在哪一段就是哪一根", () => {
    // 30 格、180px：一格 6px。柱子本身只有 4~5px 宽，按柱子自己的命中区算就点不中。
    expect(resolveTouchBucketIndex(100, rect, 30)).toBe(0);
    expect(resolveTouchBucketIndex(100 + 6 * 15 + 3, rect, 30)).toBe(15);
    expect(resolveTouchBucketIndex(100 + 179, rect, 30)).toBe(29);
  });

  it("按到条外也给个结果：夹到两端，不返回 null 让这一下白点", () => {
    expect(resolveTouchBucketIndex(80, rect, 30)).toBe(0);
    expect(resolveTouchBucketIndex(400, rect, 30)).toBe(29);
  });

  it("没有格子、或者还没量到宽度时不选", () => {
    expect(resolveTouchBucketIndex(150, rect, 0)).toBeNull();
    expect(resolveTouchBucketIndex(150, { left: 0, width: 0 }, 30)).toBeNull();
  });

  it("气泡留的时间够读完一行，又不至于杵着挡卡片", () => {
    expect(TOUCH_BUCKET_HOLD_MS).toBeGreaterThanOrEqual(1_500);
    expect(TOUCH_BUCKET_HOLD_MS).toBeLessThanOrEqual(5_000);
  });
});
