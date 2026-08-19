import { describe, expect, it } from "vitest";
import {
  assessNodePingHealth,
  estimateRefreshRowCount,
  shouldPromptPingRefresh,
  summarizePingHealth,
  type NodePingHealth,
} from "@/utils/pingWindowHealth";
import type { PingOverviewBucket } from "@/types/cfsm";

const NOW = Date.UTC(2026, 7, 19, 12, 0);
const BUCKET_MS = 120_000;

/**
 * 造 30 格窗口。`fill(index)` 返回这一格的延迟（null = 空缺）；
 * 丢包一律给 0 —— 探测正常时它本来就是 0，不该被当成「数据有问题」的证据。
 */
function bucketsOf(
  fill: (index: number) => number | null,
  offline: (index: number) => boolean = () => false,
): PingOverviewBucket[] {
  const windowStart = NOW - 30 * BUCKET_MS;
  return Array.from({ length: 30 }, (_, index) => {
    const value = fill(index);
    return {
      index,
      value,
      loss: value == null ? null : 0,
      total: value == null ? 0 : 1,
      lost: 0,
      startAt: windowStart + index * BUCKET_MS,
      endAt: windowStart + (index + 1) * BUCKET_MS,
      offline: offline(index),
    };
  });
}

function healthy(uuid: string): NodePingHealth {
  return {
    uuid,
    assessable: 30,
    filled: 30,
    gapRatio: 0,
    backfillRatio: 0,
    reasons: [],
    suspect: false,
  };
}

function suspect(uuid: string, reasons: NodePingHealth["reasons"]): NodePingHealth {
  return { ...healthy(uuid), filled: 0, gapRatio: 1, reasons, suspect: true };
}

describe("单台节点的延迟数据自检", () => {
  it("柱子画满了就不算有问题", () => {
    const result = assessNodePingHealth(
      {
        uuid: "a",
        buckets: bucketsOf((index) => 120 + (index % 5)),
        windowSlots: 30,
        droppedSlots: 0,
        offlineSince: null,
      },
      NOW,
    );

    expect(result?.suspect).toBe(false);
    expect(result?.gapRatio).toBe(0);
  });

  it("丢包全是 0 不算证据：延迟在正常波动就该判为没问题", () => {
    // 用户反馈里特意提过这一条 —— 探测正常时丢包本来就该是 0，
    // 拿它当「数据可疑」的判据会把好节点全判成坏的。
    const buckets = bucketsOf((index) => 30 + (index % 3));
    expect(buckets.every((bucket) => bucket.loss === 0)).toBe(true);

    const result = assessNodePingHealth(
      { uuid: "a", buckets, windowSlots: 30, droppedSlots: 0, offlineSince: null },
      NOW,
    );

    expect(result?.suspect).toBe(false);
  });

  it("三分之一以上的格子空着就算「柱子明显空缺」", () => {
    const result = assessNodePingHealth(
      {
        uuid: "a",
        // 前 12 格空着（复印段被丢掉之后的样子）。
        buckets: bucketsOf((index) => (index < 12 ? null : 120)),
        windowSlots: 30,
        droppedSlots: 0,
        offlineSince: null,
      },
      NOW,
    );

    expect(result?.suspect).toBe(true);
    expect(result?.reasons).toContain("gap");
  });

  it("只空几格不报：窗口末尾对不齐、偶尔漏一格是常态", () => {
    const result = assessNodePingHealth(
      {
        uuid: "a",
        buckets: bucketsOf((index) => (index < 4 ? null : 120)),
        windowSlots: 30,
        droppedSlots: 0,
        offlineSince: null,
      },
      NOW,
    );

    expect(result?.suspect).toBe(false);
  });

  it("窗口里大半是复印段、但柱子被本地实测铺满了：不报", () => {
    // 窗口再假也已经被丢掉了，卡片上画的是真数据 —— 这时候再花一次 D1 没有意义。
    const result = assessNodePingHealth(
      {
        uuid: "a",
        buckets: bucketsOf(() => 120),
        windowSlots: 30,
        droppedSlots: 24,
        offlineSince: null,
      },
      NOW,
    );

    expect(result?.suspect).toBe(false);
    expect(result?.backfillRatio).toBeCloseTo(0.8);
  });

  it("既空缺、后端那一份又大半是复印段：理由里两条都写上", () => {
    const result = assessNodePingHealth(
      {
        uuid: "a",
        buckets: bucketsOf((index) => (index < 20 ? null : 120)),
        windowSlots: 30,
        droppedSlots: 20,
        offlineSince: null,
      },
      NOW,
    );

    expect(result?.reasons).toEqual(["gap", "backfilled"]);
  });

  it("掉线的格子不算空缺", () => {
    // 掉线段是照实画的红格，不该被数成「没数据」。
    const result = assessNodePingHealth(
      {
        uuid: "a",
        buckets: bucketsOf(
          (index) => (index >= 18 ? null : 120),
          (index) => index >= 18,
        ),
        windowSlots: 30,
        droppedSlots: 0,
        offlineSince: NOW - 24 * 60_000,
      },
      NOW,
    );

    expect(result?.suspect).toBe(false);
    expect(result?.assessable).toBe(18);
  });

  it("掉线超过半小时的节点整台不判", () => {
    const result = assessNodePingHealth(
      {
        uuid: "a",
        buckets: bucketsOf(() => null, () => true),
        windowSlots: 30,
        droppedSlots: 0,
        offlineSince: NOW - 45 * 60_000,
      },
      NOW,
    );

    expect(result).toBeNull();
  });

  it("可判定的格子太少就不判（刚掉线不久、能看的只剩几格）", () => {
    const result = assessNodePingHealth(
      {
        uuid: "a",
        buckets: bucketsOf(() => null, (index) => index >= 5),
        windowSlots: 30,
        droppedSlots: 0,
        offlineSince: NOW - 25 * 60_000,
      },
      NOW,
    );

    expect(result).toBeNull();
  });

  it("后端压根没给过窗口的节点不判：刷新也查不出行来", () => {
    const result = assessNodePingHealth(
      { uuid: "a", buckets: null, windowSlots: 0, droppedSlots: 0, offlineSince: null },
      NOW,
    );

    expect(result).toBeNull();
  });

  it("给过窗口、但整段是复印件被丢光：这台最该刷", () => {
    const result = assessNodePingHealth(
      { uuid: "a", buckets: null, windowSlots: 30, droppedSlots: 30, offlineSince: null },
      NOW,
    );

    expect(result?.suspect).toBe(true);
    expect(result?.reasons).toEqual(["gap", "backfilled"]);
  });
});

describe("这一屏值不值得弹窗", () => {
  it("全都正常时不弹", () => {
    const summary = summarizePingHealth([healthy("a"), healthy("b"), null]);
    expect(summary.assessed).toBe(2);
    expect(shouldPromptPingRefresh(summary)).toBe(false);
  });

  it("八台里只有一台可疑不弹：刷新是全场一起付钱，留给手动按钮", () => {
    const results = [
      suspect("a", ["gap"]),
      ...Array.from({ length: 7 }, (_, index) => healthy(`ok-${index}`)),
    ];

    expect(shouldPromptPingRefresh(summarizePingHealth(results))).toBe(false);
  });

  it("四分之一的节点可疑就弹", () => {
    const results = [
      suspect("a", ["gap"]),
      suspect("b", ["gap", "backfilled"]),
      ...Array.from({ length: 6 }, (_, index) => healthy(`ok-${index}`)),
    ];
    const summary = summarizePingHealth(results);

    // 「后端在编数据」是空缺的子集，所以两台都算空缺、其中一台带得出理由。
    expect(summary).toMatchObject({
      assessed: 8,
      suspects: 2,
      gapNodes: 2,
      backfilledNodes: 1,
    });
    expect(shouldPromptPingRefresh(summary)).toBe(true);
  });

  it("一台节点的面板：那一台坏了就该弹", () => {
    expect(shouldPromptPingRefresh(summarizePingHealth([suspect("a", ["gap"])]))).toBe(true);
  });

  it("一台都判不了时不弹（全掉线、或后端不探测）", () => {
    expect(shouldPromptPingRefresh(summarizePingHealth([null, null]))).toBe(false);
  });
});

describe("刷新要读多少行 D1", () => {
  it("按 3600 ÷ 上报间隔逐台相加", () => {
    // CLAUDE.md 的口径：30 秒上报的节点一小时 120 行。
    expect(estimateRefreshRowCount([30, 30, 60])).toBe(120 + 120 + 60);
  });

  it("间隔缺失或是 0 时按 60 秒算，不至于报出 Infinity", () => {
    expect(estimateRefreshRowCount([0, Number.NaN])).toBe(120);
  });

  it("节点数变了这个数就跟着变，不是常量", () => {
    expect(estimateRefreshRowCount(Array.from({ length: 8 }, () => 30))).toBe(960);
    expect(estimateRefreshRowCount(Array.from({ length: 16 }, () => 30))).toBe(1920);
  });
});
