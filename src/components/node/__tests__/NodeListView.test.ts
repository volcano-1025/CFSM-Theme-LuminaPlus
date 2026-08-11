import { describe, expect, it } from "vitest";
import {
  formatListPingStatus,
  resolveListPingState,
} from "@/components/node/NodeListView";

describe("node list ping status", () => {
  it("distinguishes an unconfigured node from an assigned request", () => {
    expect(resolveListPingState(undefined, false, false)).toBe("unconfigured");
    expect(resolveListPingState("pending", true, true)).toBe("pending");
    expect(resolveListPingState(undefined, true, false)).toBe("pending");
  });

  it("shows loading text when an assigned task has no value yet", () => {
    expect(formatListPingStatus(null, "pending")).toEqual({
      visibleText: "加载中",
      title: "正在加载首页 Ping",
      ariaText: "首页 Ping 加载中",
    });
  });

  it("keeps a stale value visible but announces a failed refresh", () => {
    expect(formatListPingStatus(42.4, "error")).toEqual({
      visibleText: "42",
      title: "首页 Ping 刷新失败，显示上次数据",
      ariaText: "42 毫秒，首页 Ping 刷新失败，显示上次数据",
    });
  });

  it("shows a failed request when it has no previous value", () => {
    expect(formatListPingStatus(null, "error")).toEqual({
      visibleText: "加载失败",
      title: "首页 Ping 加载失败",
      ariaText: "首页 Ping 加载失败",
    });
  });

  it("keeps simulated assigned ping in the normal display state", () => {
    expect(resolveListPingState(undefined, false, true)).toBe("ready");
    expect(formatListPingStatus(null, "ready").visibleText).toBe("无样本");
  });
});
