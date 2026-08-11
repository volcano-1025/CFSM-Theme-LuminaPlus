import { describe, expect, it } from "vitest";
import {
  buildLoadTimeRangeOptions,
  buildPingTimeRangeOptions,
} from "@/components/instance/chartShared";

const ALL_STEPS = [
  { label: "1 小时", value: 1 },
  { label: "6 小时", value: 6 },
  { label: "12 小时", value: 12 },
  { label: "1 天", value: 24 },
  { label: "2 天", value: 48 },
  { label: "7 天", value: 168 },
];

describe("detail chart time ranges", () => {
  it("offers every backend-supported step to a logged-in admin", () => {
    // 后端 /api/history/all 最长支持 7 天，没有更长的档位可选。
    expect(buildPingTimeRangeOptions(168)).toEqual(ALL_STEPS);
    expect(buildLoadTimeRangeOptions(168)).toEqual([
      { label: "实时", value: 0 },
      ...ALL_STEPS,
    ]);
  });

  it("caps anonymous visitors at 24 hours", () => {
    // 未登录时 hours > 24 会被后端拒绝，因此更长的档位不显示。
    expect(buildPingTimeRangeOptions(24)).toEqual([
      { label: "1 小时", value: 1 },
      { label: "6 小时", value: 6 },
      { label: "12 小时", value: 12 },
      { label: "1 天", value: 24 },
    ]);
    expect(buildLoadTimeRangeOptions(24)).toEqual([
      { label: "实时", value: 0 },
      { label: "1 小时", value: 1 },
      { label: "6 小时", value: 6 },
      { label: "12 小时", value: 12 },
      { label: "1 天", value: 24 },
    ]);
  });
});
