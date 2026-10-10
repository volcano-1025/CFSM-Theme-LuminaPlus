// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPingHistorySnapshot,
  recordPingSample,
  resetPingLiveStore,
  retainPingNodes,
  seedMeasuredHistory,
  seedPingHistory,
  setWindowBackfillGuard,
  subscribePingHistory,
  type PingLiveSample,
} from "@/services/pingLiveStore";
import { buildPingBuckets, buildPingOverviewItem } from "@/hooks/usePingOverview";
import { EMPTY_CARRIER_PING, type CarrierPingSnapshot } from "@/types/cfsm";

const NOW = Date.UTC(2026, 6, 17, 12, 0);

function ping(values: Partial<CarrierPingSnapshot>): CarrierPingSnapshot {
  return { ...EMPTY_CARRIER_PING, ...values };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  resetPingLiveStore();
});

afterEach(() => {
  vi.useRealTimers();
  resetPingLiveStore();
});

describe("recordPingSample", () => {
  it("appends one sample per report timestamp", () => {
    recordPingSample("node-a", NOW - 60_000, ping({ ct: 30 }));
    recordPingSample("node-a", NOW, ping({ ct: 32 }));

    const samples = getPingHistorySnapshot("node-a");
    expect(samples.map((sample) => sample.ping.ct)).toEqual([30, 32]);
  });

  it("重复推同一个探测结果时只留心跳采样", () => {
    // 探针 60 秒才测一次，WS 每 2 秒推一帧：同一个结果被推 30 次，不该记 30 个样本。
    for (let i = 0; i < 90; i++) {
      recordPingSample("node-a", NOW + i * 2_000, ping({ ct: 30 }));
    }

    // 180 秒 / 2 分钟一个心跳 → 首个 + 之后每 2 分钟。
    expect(getPingHistorySnapshot("node-a")).toHaveLength(2);
  });

  it("records a changed reading sooner than the idle throttle", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-a", NOW + 25_000, ping({ ct: 80 }));

    expect(getPingHistorySnapshot("node-a").map((s) => s.ping.ct)).toEqual([30, 80]);
  });

  it("新的探测结果一到就记，不再等一个节流窗口", () => {
    // 「值变了」等价于「新探测落地了」，压着不记会让丢包那一次错位到下一格。
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-a", NOW + 6_000, ping({ ct: 80 }));

    expect(getPingHistorySnapshot("node-a").map((s) => s.ping.ct)).toEqual([30, 80]);
  });

  it("同一帧里的抖动仍旧挡住", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-a", NOW + 2_000, ping({ ct: 80 }));

    expect(getPingHistorySnapshot("node-a")).toHaveLength(1);
  });

  it("值一直在变时每次探测都记，覆盖整整一小时", () => {
    for (let i = 0; i < 60; i++) {
      recordPingSample("node-a", NOW + i * 60_000, ping({ ct: 30 + i }));
    }

    const samples = getPingHistorySnapshot("node-a");
    expect(samples).toHaveLength(60);
    // 首尾跨度覆盖整整一小时，图表 30 格能填满。
    expect(samples.at(-1)!.time - samples[0]!.time).toBe(59 * 60_000);
  });

  it("ignores repeats of the same report, so callers can call it every frame", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    const first = getPingHistorySnapshot("node-a");
    recordPingSample("node-a", NOW, ping({ ct: 30 }));

    expect(getPingHistorySnapshot("node-a")).toBe(first);
  });

  it("ignores out-of-order reports", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-a", NOW - 30_000, ping({ ct: 99 }));

    expect(getPingHistorySnapshot("node-a")).toHaveLength(1);
  });

  it("skips nodes with no carrier configured at all", () => {
    recordPingSample("node-a", NOW, EMPTY_CARRIER_PING);

    expect(getPingHistorySnapshot("node-a")).toEqual([]);
  });

  it("drops samples that fall out of the retention window", () => {
    // 保留期比后端 2 小时窗口多留一点余量（见 SAMPLE_TTL_MS），3 小时前的样本一定过期。
    recordPingSample("node-a", NOW - 3 * 60 * 60_000, ping({ ct: 10 }));
    recordPingSample("node-a", NOW, ping({ ct: 20 }));

    expect(getPingHistorySnapshot("node-a").map((s) => s.ping.ct)).toEqual([20]);
  });

  it("caps the buffer instead of growing without bound", () => {
    for (let i = 0; i < 400; i++) {
      recordPingSample("node-a", NOW + i * 60_000, ping({ ct: i % 90 }));
    }

    expect(getPingHistorySnapshot("node-a").length).toBeLessThanOrEqual(192);
  });

  it("notifies subscribers of the affected node only", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    subscribePingHistory("node-a", onA);
    subscribePingHistory("node-b", onB);

    recordPingSample("node-a", NOW, ping({ ct: 30 }));

    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
  });
});

describe("persistence", () => {
  it("restores the buffer after a reload so the chart is not blank", () => {
    // 本地样本是主数据源（后端窗口是向后填充出来的低保真数据），刷新就丢等于每次刷新
    // 都退回那份填充值。
    recordPingSample("node-a", NOW - 60_000, ping({ ct: 30, lossCt: 0 }));
    recordPingSample("node-a", NOW, ping({ ct: 31, lossCt: 5 }));
    vi.advanceTimersByTime(20_000);

    resetPingLiveStore();
    const restored = getPingHistorySnapshot("node-a");

    expect(restored.map((sample) => sample.ping.ct)).toEqual([30, 31]);
    expect(restored.at(-1)?.ping.lossCt).toBe(5);
  });

  it("does not restore samples that have expired while away", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    vi.advanceTimersByTime(20_000);

    resetPingLiveStore();
    vi.setSystemTime(NOW + 3 * 60 * 60_000);

    expect(getPingHistorySnapshot("node-a")).toEqual([]);
  });

  it("keeps samples from a site that only configured the new lines", () => {
    // 站点可能只给后四条自定义槽位配了探测目标，前四条全空。判「有没有值」只看前四条的话，
    // recordPingSample 会直接 return，这台节点一个样本都攒不出来、柱子全空。
    recordPingSample("node-only-new", NOW, ping({ node_1: 42, lossNode1: 0 }));

    const [sample] = getPingHistorySnapshot("node-only-new");
    expect(sample?.ping.node_1).toBe(42);
  });

  it("records a new sample when only a new line's value changed", () => {
    // 「值变了就记一个样本」靠 samePing 判断。只比前四条的话，后四条的探测落地会被判成
    // 「没变」而不记，新线路的数据被系统性漏采。
    recordPingSample("node-mixed", NOW, ping({ ct: 30, node_1: 40 }));
    vi.advanceTimersByTime(10_000);
    recordPingSample("node-mixed", NOW + 10_000, ping({ ct: 30, node_1: 55 }));

    const samples = getPingHistorySnapshot("node-mixed");
    expect(samples).toHaveLength(2);
    expect(samples[1]?.ping.node_1).toBe(55);
  });

  it("still reads a buffer written before the line count went 4 → 8", () => {
    // 老版本存的是 9 列 [time, ct,cu,cm,bd, lossCt,lossCu,lossCm,lossBd]。升级后列数变 17，
    // 按长度反推每段多长，读不出来的话整段缓冲作废、柱子会空一大片。
    window.localStorage.setItem(
      "cfsm-luminaplus:ping-live:v1",
      JSON.stringify({
        v: 1,
        savedAt: NOW,
        nodes: { "node-a": [[NOW - 60_000, 30, 40, 50, 60, 0, 1, 2, 3]] },
      }),
    );
    resetPingLiveStore();

    const [sample] = getPingHistorySnapshot("node-a");
    expect(sample?.ping.ct).toBe(30);
    expect(sample?.ping.bd).toBe(60);
    expect(sample?.ping.lossCu).toBe(1);
    expect(sample?.ping.lossBd).toBe(3);
    // 老数据里没有的新线路留空，而不是把丢包值错位读成延迟。
    expect(sample?.ping.node_1).toBeNull();
    expect(sample?.ping.lossNode1).toBeNull();
  });

  it("survives a corrupted cache entry", () => {
    window.localStorage.setItem("cfsm-luminaplus:ping-live:v1", "{not json");
    resetPingLiveStore();

    expect(getPingHistorySnapshot("node-a")).toEqual([]);
  });
});

describe("seedPingHistory", () => {
  /** 后端窗口：30 个点、每 2 分钟一个，覆盖最近一小时。 */
  function backendWindow(): PingLiveSample[] {
    return Array.from({ length: 30 }, (_, index) => ({
      time: NOW - (29 - index) * 120_000,
      ping: ping({ ct: 30 + index, lossCt: 0 }),
    }));
  }

  it("fills a whole hour on the first load, without accumulating", () => {
    seedPingHistory("node-a", backendWindow());

    const samples = getPingHistorySnapshot("node-a");
    expect(samples).toHaveLength(30);
    expect(samples.at(-1)!.time - samples[0]!.time).toBe(29 * 120_000);
  });

  it("本地有实测的时段用本地值，窗口那份填充值让位", () => {
    // 线上实测：窗口是拿最近一次结果向后填充的，某节点前 48 分钟是同一个数字重复，
    // 而同一时段浏览器攒到的是真测量 —— 有真的就不该显示填出来的。
    seedPingHistory("node-a", backendWindow());
    for (let i = 0; i < 20; i += 1) {
      recordPingSample("node-a", NOW - 20 * 60_000 + i * 60_000, ping({ ct: 999 + i }));
    }

    const samples = getPingHistorySnapshot("node-a");
    // 本地覆盖到的那一段（首尾各留一格给边界）里，不该再有窗口的填充值。
    const inside = samples.filter(
      (sample) => sample.time > NOW - 19 * 60_000 && sample.time < NOW - 2 * 60_000,
    );
    expect(inside.length).toBeGreaterThan(10);
    expect(inside.every((sample) => (sample.ping.ct ?? 0) >= 999)).toBe(true);
    // 更早的那 40 分钟浏览器没开着，仍旧由窗口顶着。
    expect(samples.some((sample) => sample.time < NOW - 30 * 60_000)).toBe(true);
  });

  it("浏览器没覆盖到的时段仍旧用窗口，并按疏密配权重", () => {
    // 一小时里只有最近 10 分钟有本地样本，其余靠窗口 —— 窗口点要抵几个本地点，
    // 否则「本地那段」的样本条数是「窗口那段」的好几倍，丢包率会往它偏。
    for (let i = 0; i < 15; i += 1) {
      recordPingSample("node-a", NOW - 10 * 60_000 + i * 60_000, ping({ ct: 777 + i }));
    }
    seedPingHistory("node-a", backendWindow());

    const samples = getPingHistorySnapshot("node-a");
    const fromLocal = samples.filter((sample) => (sample.ping.ct ?? 0) >= 777);
    const fromWindow = samples.filter((sample) => (sample.ping.ct ?? 0) < 777);
    expect(fromLocal.length).toBeGreaterThan(5);
    expect(fromWindow.length).toBeGreaterThan(20);
    // 窗口 2 分钟一格、本地实测 1 分钟一个 → 一个窗口点抵两个本地点。
    // 取中间的样本比：首尾和交界处的样本代表的时长是单边算的，本来就不齐。
    const mid = (list: typeof samples) => list[Math.floor(list.length / 2)]?.weight ?? 0;
    expect(mid(fromWindow) / mid(fromLocal)).toBeCloseTo(2, 1);
  });

  it("窗口里没值的那一格，用本地实测点顶替", () => {
    // 后端这轮探测没出结果（格子在、值是 null）。图表对「明确没值的槽位」是真的留空的，
    // 本地却正好测到了值 —— 不顶替就会平白空一格（线上看到的「柱子中间缺一格」）。
    const withEmptySlot = backendWindow().map((sample, index) =>
      index === 25 ? { ...sample, ping: ping({}) } : sample,
    );
    recordPingSample("node-a", NOW - 8 * 60_000 - 20_000, ping({ ct: 61 }));

    seedPingHistory("node-a", withEmptySlot);

    const samples = getPingHistorySnapshot("node-a");
    expect(samples.map((sample) => sample.ping.ct)).toContain(61);
    // 顶替，不是插队：总数不变。
    expect(samples).toHaveLength(30);
  });

  it("没值的那一格附近也没有本地样本时，仍旧留空不编数据", () => {
    const withEmptySlot = backendWindow().map((sample, index) =>
      index === 25 ? { ...sample, ping: ping({}) } : sample,
    );

    seedPingHistory("node-a", withEmptySlot);

    const samples = getPingHistorySnapshot("node-a");
    expect(samples).toHaveLength(30);
    expect(samples[25]?.ping.ct).toBeNull();
  });

  it("权重让丢包率按时间算，而不是按样本条数算", () => {
    // 半小时窗口(0% 丢包) + 半小时本地实测(30% 丢包)。本地 40 秒一个、窗口 2 分钟一个，
    // 不配权重的话本地那半段占 3/4 条数，丢包率会算成约 22%；按时间应该是 15%。
    for (let i = 0; i < 45; i += 1) {
      recordPingSample("node-a", NOW - 30 * 60_000 + i * 40_000, ping({ ct: 45, lossCt: 30 }));
    }
    seedPingHistory("node-a", backendWindow());

    const item = buildPingOverviewItem("node-a", 1, getPingHistorySnapshot("node-a"));
    expect(item.loss).toBeGreaterThan(12);
    expect(item.loss).toBeLessThan(18);
  });

  it("窗口末点迟迟不更新时，用本地点补到现在", () => {
    // 后端快照卡住的情形：窗口整体停在 10 分钟前，右端不能就这么空着。
    const staleWindow = backendWindow().map((sample) => ({
      ...sample,
      time: sample.time - 10 * 60_000,
    }));
    recordPingSample("node-a", NOW - 6 * 60_000, ping({ ct: 71 }));
    recordPingSample("node-a", NOW - 3 * 60_000, ping({ ct: 72 }));

    seedPingHistory("node-a", staleWindow);

    const values = getPingHistorySnapshot("node-a").map((sample) => sample.ping.ct);
    expect(values).toContain(71);
    expect(values).toContain(72);
  });

  it("keeps locally accumulated samples that fill a hole in the window", () => {
    // 线上实测的窗口形状：2 分钟网格在约 35 分钟前就停了，末尾直接追加一个「当前」点，
    // 中间是空洞。浏览器攒下的样本正好覆盖那段，不能因为它们比窗口末点旧就被丢掉。
    const holeyWindow: PingLiveSample[] = [
      ...Array.from({ length: 12 }, (_, index) => ({
        time: NOW - 55 * 60_000 + index * 120_000,
        ping: ping({ ct: 30 + index, lossCt: 0 }),
      })),
      { time: NOW, ping: ping({ ct: 42, lossCt: 0 }) },
    ];
    // 空洞期间本地记下的点（例如上次开着页面时累积、并已持久化）。
    recordPingSample("node-a", NOW - 20 * 60_000, ping({ ct: 55 }));
    recordPingSample("node-a", NOW - 10 * 60_000, ping({ ct: 56 }));

    seedPingHistory("node-a", holeyWindow);

    const samples = getPingHistorySnapshot("node-a");
    const times = samples.map((sample) => sample.time);
    expect(times).toContain(NOW - 20 * 60_000);
    expect(times).toContain(NOW - 10 * 60_000);
    expect(samples).toHaveLength(15);
    // 仍按时间升序，且同一时刻以后端为准。
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(samples.at(-1)?.ping.ct).toBe(42);
  });

  it("keeps full-hour coverage when dense live samples would overflow the cap", () => {
    // 线上实测的状态：密集的本地样本很快顶满上限，却只覆盖最近约半小时；
    // 若超限时直接砍最老的，就会把后端窗口里较早的点整段丢掉 —— 柱子左半段空、右半段有。
    // 90 个点、20 秒一个，正好覆盖最近 30 分钟（未触及上限，触发点在合并之后）。
    for (let index = 0; index < 90; index += 1) {
      recordPingSample(
        "node-a",
        NOW - 30 * 60_000 + index * 20_000,
        ping({ ct: 40 + (index % 5) }),
      );
    }
    seedPingHistory("node-a", backendWindow());

    const samples = getPingHistorySnapshot("node-a");
    const oldestAgoMin = (NOW - samples[0]!.time) / 60_000;
    // 仍然覆盖接近整小时，而不是只剩最近半小时。
    expect(oldestAgoMin).toBeGreaterThan(55);
    // 前半小时（窗口独有的那段）必须还有点。
    expect(samples.filter((s) => s.time < NOW - 30 * 60_000).length).toBeGreaterThan(10);
  });

  it("does not notify subscribers when the window is unchanged", () => {
    seedPingHistory("node-a", backendWindow());
    const listener = vi.fn();
    subscribePingHistory("node-a", listener);

    seedPingHistory("node-a", backendWindow());

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies when the window advances", () => {
    seedPingHistory("node-a", backendWindow());
    const listener = vi.fn();
    subscribePingHistory("node-a", listener);

    seedPingHistory("node-a", [
      ...backendWindow().slice(1),
      { time: NOW + 120_000, ping: ping({ ct: 77 }) },
    ]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPingHistorySnapshot("node-a").at(-1)?.ping.ct).toBe(77);
  });

  it("ignores an empty window so an older backend keeps its accumulated data", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    seedPingHistory("node-a", []);

    expect(getPingHistorySnapshot("node-a")).toHaveLength(1);
  });

  it("drops window points that already fell out of the hour", () => {
    seedPingHistory("node-a", [
      { time: NOW - 3 * 60 * 60_000, ping: ping({ ct: 10 }) },
      { time: NOW, ping: ping({ ct: 20 }) },
    ]);

    expect(getPingHistorySnapshot("node-a").map((s) => s.ping.ct)).toEqual([20]);
  });
});

describe("本地样本稀疏时不能挤掉窗口", () => {
  const TWO_HOURS = 2 * 60 * 60_000;

  /** 线上那种窗口：20 格、6 分钟一格，最新一格比 now 早几分钟。 */
  function twoHourWindow(): PingLiveSample[] {
    return Array.from({ length: 20 }, (_, index) => ({
      time: NOW - 7 * 60_000 - (19 - index) * 6 * 60_000,
      ping: ping({ cu: 30 + (index % 5), lossCu: 0 }),
    }));
  }

  function barShape(): string {
    const item = buildPingOverviewItem("node-a", 2, getPingHistorySnapshot("node-a"));
    return buildPingBuckets(item, 20, NOW, null, TWO_HOURS)
      .map((bucket) => (bucket.value == null ? "·" : "█"))
      .join("");
  }

  it("刚打开页面、本机只有上次会话留下的一个样本时，柱子照样铺满", () => {
    // 2026-09-19 站长面板：窗口 20/20 完整，本机样本 2 个，柱子只剩首尾两格。
    // 两个样本的中位间隔就是两次打开之间那一大段，窗口点全被当成「本地覆盖到了」。
    recordPingSample("node-a", NOW - 100 * 60_000, ping({ cu: 33, lossCu: 0 }));
    vi.advanceTimersByTime(20_000);
    resetPingLiveStore();
    vi.setSystemTime(NOW);

    seedPingHistory("node-a", twoHourWindow());
    recordPingSample("node-a", NOW - 1_000, ping({ cu: 34, lossCu: 0 }));

    expect(barShape()).toBe("█".repeat(20));
  });

  it("详情页看长区间回灌的稀疏历史行，不会把中间的窗口点挤掉", () => {
    // 7 天图约 40 分钟一行：这几行之间不是连续实测，窗口点得留着。
    seedPingHistory("node-a", twoHourWindow());
    seedMeasuredHistory(
      "node-a",
      [NOW - 110 * 60_000, NOW - 70 * 60_000, NOW - 30 * 60_000].map((time) => ({
        time,
        ping: ping({ cu: 40, lossCu: 0 }),
      })),
    );

    expect(barShape()).toBe("█".repeat(20));
  });
});

describe("seedMeasuredHistory", () => {
  function backendWindowFilled(): PingLiveSample[] {
    // 线上那种「向后填充」的窗口：整段同一个值、丢包全 0。
    return Array.from({ length: 30 }, (_, index) => ({
      time: NOW - (29 - index) * 120_000,
      ping: ping({ ct: 240, lossCt: 0 }),
    }));
  }

  it("详情页看过的节点，首页改用历史里的真实采样", () => {
    seedPingHistory("node-a", backendWindowFilled());
    const rows: PingLiveSample[] = Array.from({ length: 60 }, (_, index) => ({
      time: NOW - (59 - index) * 60_000,
      ping: ping({ ct: index % 5 === 0 ? 700 : 238, lossCt: index % 5 === 0 ? 20 : 0 }),
    }));

    seedMeasuredHistory("node-a", rows);

    const item = buildPingOverviewItem("node-a", 1, getPingHistorySnapshot("node-a"));
    // 窗口说一整小时零丢包，历史里五分之一的采样丢 20%。
    expect(item.loss).toBeGreaterThan(2);
  });

  it("同一时刻以历史为准，并且不动更新的实时样本", () => {
    recordPingSample("node-a", NOW - 30 * 60_000, ping({ ct: 111 }));
    recordPingSample("node-a", NOW, ping({ ct: 222 }));

    seedMeasuredHistory("node-a", [
      { time: NOW - 30 * 60_000, ping: ping({ ct: 333 }) },
    ]);

    const values = getPingHistorySnapshot("node-a").map((sample) => sample.ping.ct);
    expect(values).toContain(333);
    expect(values).not.toContain(111);
    expect(values).toContain(222);
  });

  it("丢掉超过一小时的历史行，不撑爆缓冲区", () => {
    seedMeasuredHistory("node-a", [
      { time: NOW - 3 * 60 * 60_000, ping: ping({ ct: 10 }) },
      { time: NOW - 10 * 60_000, ping: ping({ ct: 20 }) },
    ]);

    expect(getPingHistorySnapshot("node-a").map((s) => s.ping.ct)).toEqual([20]);
  });
});

describe("采样与计权的准确度", () => {
  /** 探针 60 秒一次探测，WS 每 2 秒把同一个结果重推一遍；60 次里 8 次丢包。 */
  function feedProbes() {
    let lossy = 0;
    for (let i = 0; i < 60; i += 1) {
      const isLossy = i % 7 === 3;
      if (isLossy) lossy += 1;
      for (let frame = 0; frame < 30; frame += 1) {
        recordPingSample(
          "node-a",
          NOW - (59 - i) * 60_000 + frame * 2_000,
          ping({ ct: isLossy ? 260 : 240, lossCt: isLossy ? 16.7 : 0 }),
        );
      }
    }
    return (lossy * 16.7) / 60;
  }

  it("丢包率贴近按时间的真值，不被采样规则带偏", () => {
    // 早先「值没变 50 秒记一个、值变了 20 秒就放行」会在每次丢包的切换处多记一个样本，
    // 加上按中点计权，真值 2.50% 会算成 3.85%（高估 54%）。
    const truth = feedProbes();
    const loss = buildPingOverviewItem("node-a", 1, getPingHistorySnapshot("node-a")).loss ?? 0;

    expect(Math.abs(loss - truth) / truth).toBeLessThan(0.15);
  });

  it("和后端 6 分钟一格的窗口合并后，丢包率仍按时间算", () => {
    // 线上窗口是 2 小时 20 个点（约 6 分钟一格）：前一小时只有窗口（不丢包），后一小时是本地实测。
    // 权重的份数曾经按「一格八份」算，格子一宽到 6 分钟，60 秒的丢包样本和 120 秒的心跳就分别被
    // 舍入成 1 份和 3 份（该是 1 : 2），丢包样本整体吃亏：这个构造下算出 0.95%，真值 1.25%。
    const truthLastHour = feedProbes();
    seedPingHistory(
      "node-a",
      Array.from({ length: 20 }, (_, index) => ({
        time: NOW - (19 - index) * 6 * 60_000,
        // 延迟逐格不同：一模一样的连续格子会被当成后端复印件整段丢掉（见 dropBackfilledRuns）。
        ping: ping({ ct: 200 + index, lossCt: 0 }),
      })),
    );
    const truth = truthLastHour / 2;
    const loss = buildPingOverviewItem("node-a", 1, getPingHistorySnapshot("node-a")).loss ?? 0;

    expect(Math.abs(loss - truth) / truth).toBeLessThan(0.15);
  });

  it("重复帧不进缓冲区：一小时的样本数与探测次数同量级", () => {
    feedProbes();

    // 1800 帧、60 次探测 —— 样本数该在几十，不是上千也不是个位数。
    expect(getPingHistorySnapshot("node-a").length).toBeLessThan(70);
    expect(getPingHistorySnapshot("node-a").length).toBeGreaterThan(20);
  });
});

describe("retainPingNodes", () => {
  it("drops buffers for nodes that no longer exist", () => {
    recordPingSample("node-a", NOW, ping({ ct: 30 }));
    recordPingSample("node-b", NOW, ping({ ct: 40 }));

    retainPingNodes(["node-a"]);

    expect(getPingHistorySnapshot("node-a")).toHaveLength(1);
    expect(getPingHistorySnapshot("node-b")).toEqual([]);
  });
});

describe("丢弃后端窗口里复制出来的格子", () => {
  const NOW = Date.now();
  const STEP = 120_000;

  function windowOf(values: Array<[number, number, number]>): PingLiveSample[] {
    return values.map(([ct, cu, cm], index) => ({
      time: NOW - (values.length - 1 - index) * STEP,
      ping: {
        ...EMPTY_CARRIER_PING,
        ct,
        cu,
        cm,
        lossCt: 0,
        lossCu: 0,
        lossCm: 0,
      },
    }));
  }

  it("刚加进来的节点：整窗口都是复印件，一格都不画", () => {
    const uuid = "fresh-node";
    // 线上实测形状：30 格全是 1/1/1，而历史表里只有 6 分钟的行。
    seedPingHistory(uuid, windowOf(Array.from({ length: 30 }, () => [1, 1, 1])));

    expect(getPingHistorySnapshot(uuid)).toHaveLength(0);
  });

  it("新后端（声明了 latency_window）：延迟恒定的节点不被当成复印件丢掉", () => {
    const uuid = "steady-node";
    // 别的站长的截图：三条线路一直 4 ms / 0%，窗口里连着好多格完全一样，原来整段被丢、柱子中间空一截。
    const steady = windowOf(Array.from({ length: 20 }, () => [4, 4, 4] as [number, number, number]));
    seedPingHistory(uuid, steady);
    expect(getPingHistorySnapshot(uuid)).toHaveLength(0);

    // config 晚到：开关一变，手里的窗口按新口径重算，不用等下一次同步。
    setWindowBackfillGuard(false);
    expect(getPingHistorySnapshot(uuid)).toHaveLength(20);

    seedPingHistory("another", steady);
    expect(getPingHistorySnapshot("another")).toHaveLength(20);
  });

  it("只丢重复段，末尾真值留着", () => {
    const uuid = "partly-real";
    const values: Array<[number, number, number]> = [
      ...Array.from({ length: 27 }, () => [136, 143, 150] as [number, number, number]),
      [134, 140, 149],
      [134, 145, 149],
      [137, 141, 149],
    ];
    seedPingHistory(uuid, windowOf(values));

    const kept = getPingHistorySnapshot(uuid);
    expect(kept).toHaveLength(3);
    expect(kept.map((sample) => sample.ping.ct)).toEqual([134, 134, 137]);
  });

  it("正常波动的窗口一格不丢", () => {
    const uuid = "varying";
    const values = Array.from(
      { length: 30 },
      (_, index) => [130 + (index % 7), 140 + (index % 5), 150 + (index % 3)] as [number, number, number],
    );
    seedPingHistory(uuid, windowOf(values));

    expect(getPingHistorySnapshot(uuid)).toHaveLength(30);
  });

  it("新节点刷新之后：只画真实覆盖到的那几分钟，其余留空", () => {
    const uuid = "fresh-node-refreshed";
    // 后端窗口整段是复印件（线上 Uzumaru-tw 的形状），历史表里只有最近 6 分钟。
    seedPingHistory(uuid, windowOf(Array.from({ length: 30 }, () => [1, 1, 1])));
    seedMeasuredHistory(
      uuid,
      Array.from({ length: 12 }, (_, index) => ({
        time: NOW - (11 - index) * 30_000,
        ping: ping({ ct: 40 + index, cu: 41, cm: 42, lossCt: 0 }),
      })),
    );

    const item = buildPingOverviewItem(uuid, 1, getPingHistorySnapshot(uuid));
    const buckets = buildPingBuckets(item, 30, NOW);
    const active = buckets.filter((bucket) => bucket.total > 0).length;
    // 一小时 30 格里只有最后几格该有值，绝不该是填满的一整个小时。
    expect(active).toBeGreaterThan(0);
    expect(active).toBeLessThanOrEqual(6);
  });

  it("短暂重复（不到门槛）不算复印件", () => {
    const uuid = "short-repeat";
    const values: Array<[number, number, number]> = [
      [130, 140, 150],
      [131, 141, 151],
      [131, 141, 151],
      [131, 141, 151],
      [132, 142, 152],
      [133, 143, 153],
    ];
    seedPingHistory(uuid, windowOf(values));

    expect(getPingHistorySnapshot(uuid)).toHaveLength(6);
  });
})
