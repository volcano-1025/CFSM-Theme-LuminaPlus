import { describe, expect, it } from "vitest";
import { CfsmServerSchema, EMPTY_CARRIER_PING, type CfsmServer } from "@/types/cfsm";
import {
  carrierPingTasks,
  carrierTaskName,
  DEFAULT_CARRIER_NAMES,
  resolveCarrierNames,
  parseLatencyWindow,
  PING_TIMEOUT_VALUE,
  historyRowToLoadRecord,
  historyRowsToPingRecords,
  inferIntervalSeconds,
  isServerOnline,
  mergeServerPatch,
  normalizeTimestamp,
  normalizeTrafficCalcType,
  parseGpuInfo,
  parseLoadAvg,
  parseTrafficLimitBytes,
  toNodeInfo,
  toNodeMetrics,
} from "@/services/cfsm/mappers";
import { HistoryRowSchema } from "@/types/cfsm";

const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
const NOW = Date.parse("2026-07-16T12:00:00Z");

function server(overrides: Record<string, unknown> = {}): CfsmServer {
  return CfsmServerSchema.parse({
    id: "node-a",
    name: "Node A",
    server_group: "prod",
    region: "JP",
    is_hidden: "0",
    sort_order: 7,
    cpu: 12.5,
    load_avg: "0.10 0.20 0.30",
    net_in_speed: 2048,
    net_out_speed: 1024,
    net_rx: 900,
    net_tx: 800,
    net_rx_monthly: 500,
    net_tx_monthly: 400,
    processes: 210,
    tcp_conn: 32,
    udp_conn: 4,
    ram_total: 8192,
    ram_used: 4096,
    swap_total: 2048,
    swap_used: 256,
    disk_total: 102400,
    disk_used: 51200,
    cpu_cores: 4,
    cpu_info: "Intel Xeon",
    arch: "x86_64",
    os: "Ubuntu 22.04",
    kernel_version: "6.8.0",
    ip_v4: "1",
    ip_v6: "0",
    boot_time: String(NOW - 86_400_000),
    last_updated: NOW,
    timestamp: NOW,
    price: "30.00",
    currency: "¥",
    billing_cycle: "month",
    auto_renewal: "1",
    expire_date: "2026-12-31",
    traffic_limit: "1024",
    traffic_calc_type: "total",
    reset_day: 5,
    report_interval: 60,
    tags: "prod,edge",
    ping_ct: 23,
    ping_cu: 25,
    ping_cm: 30,
    ping_bd: 40,
    ...overrides,
  });
}

describe("normalizeTimestamp", () => {
  it("promotes second-precision timestamps to milliseconds", () => {
    expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(normalizeTimestamp("1700000000000")).toBe(1_700_000_000_000);
    expect(normalizeTimestamp("2026-07-16T00:00:00Z")).toBe(
      Date.parse("2026-07-16T00:00:00Z"),
    );
    expect(normalizeTimestamp("")).toBe(0);
  });
});

describe("parseLoadAvg", () => {
  it("splits the three-number string and pads missing entries", () => {
    expect(parseLoadAvg("0.10 0.20 0.30")).toEqual([0.1, 0.2, 0.3]);
    expect(parseLoadAvg("1.5")).toEqual([1.5, 0, 0]);
    expect(parseLoadAvg("")).toEqual([0, 0, 0]);
  });
});

describe("parseGpuInfo", () => {
  it("accepts both the array form and the JSON-string form", () => {
    const asArray = parseGpuInfo([{ id: "0", name: "RTX 3060", info: 12.5 }]);
    const asString = parseGpuInfo('[{"id":"0","name":"RTX 3060","info":12.5}]');

    expect(asArray).toEqual(asString);
    expect(asArray[0]?.name).toBe("RTX 3060");
  });

  it("treats a plain string as a bare model name", () => {
    expect(parseGpuInfo("RTX 3060")).toEqual([{ id: "0", name: "RTX 3060", info: null }]);
  });

  it("returns nothing for empty payloads", () => {
    expect(parseGpuInfo("")).toEqual([]);
    expect(parseGpuInfo("[]")).toEqual([]);
    expect(parseGpuInfo(undefined)).toEqual([]);
  });
});

describe("parseTrafficLimitBytes", () => {
  it("defaults to GB, matching the admin input", () => {
    expect(parseTrafficLimitBytes("1024")).toBe(1024 * GIB);
  });

  it("honours an explicit unit suffix", () => {
    expect(parseTrafficLimitBytes("1TB")).toBe(1024 * GIB);
    expect(parseTrafficLimitBytes("500 MB")).toBe(500 * MIB);
  });

  it("treats blank or non-positive values as unlimited", () => {
    expect(parseTrafficLimitBytes("")).toBe(0);
    expect(parseTrafficLimitBytes("0")).toBe(0);
    expect(parseTrafficLimitBytes("abc")).toBe(0);
  });
});

describe("normalizeTrafficCalcType", () => {
  it("maps the backend vocabulary onto the theme's", () => {
    expect(normalizeTrafficCalcType("total")).toBe("sum");
    expect(normalizeTrafficCalcType("ul")).toBe("up");
    expect(normalizeTrafficCalcType("dl")).toBe("down");
    expect(normalizeTrafficCalcType("max")).toBe("max");
    expect(normalizeTrafficCalcType("")).toBe("sum");
  });
});

describe("toNodeInfo", () => {
  it("converts MiB capacities to bytes and GB quota to bytes", () => {
    const info = toNodeInfo(server());

    expect(info.mem_total).toBe(8192 * MIB);
    expect(info.disk_total).toBe(102400 * MIB);
    expect(info.traffic_limit).toBe(1024 * GIB);
    expect(info.traffic_limit_type).toBe("sum");
  });

  it("maps identity, billing and visibility fields", () => {
    const info = toNodeInfo(server({ is_hidden: "1", auto_renewal: "0" }));

    expect(info.uuid).toBe("node-a");
    expect(info.group).toBe("prod");
    expect(info.weight).toBe(7);
    expect(info.hidden).toBe(true);
    expect(info.auto_renewal).toBe(false);
    expect(info.price).toBe(30);
    expect(info.expired_at).toBe("2026-12-31");
  });

  it("keeps -1 as the backend's explicit free marker", () => {
    // 归零的话卡片只会留白，显示不出「免费」。
    expect(toNodeInfo(server({ price: "-1" })).price).toBe(-1);
    expect(toNodeInfo(server({ price: "" })).price).toBe(0);
    expect(toNodeInfo(server({ price: "-3" })).price).toBe(0);
  });

  it("keeps IP reachability as a flag, since no address is exposed", () => {
    const info = toNodeInfo(server());

    expect(info.ipv4).toBe("1");
    expect(info.ipv6).toBe("");
  });
});

describe("toNodeMetrics", () => {
  it("derives percentages, load numbers and uptime", () => {
    const metrics = toNodeMetrics(server(), NOW);

    expect(metrics.ramUsed).toBe(4096 * MIB);
    expect(metrics.ramPct).toBe(50);
    expect(metrics.diskPct).toBe(50);
    expect(metrics.load1).toBe(0.1);
    expect(metrics.load15).toBe(0.3);
    expect(metrics.uptime).toBe(86_400);
    expect(metrics.netUp).toBe(1024);
    expect(metrics.netDown).toBe(2048);
  });

  it("keeps lifetime and monthly counters apart", () => {
    const metrics = toNodeMetrics(server(), NOW);

    expect(metrics.trafficUp).toBe(800);
    expect(metrics.trafficDown).toBe(900);
    expect(metrics.trafficUpMonthly).toBe(400);
    expect(metrics.trafficDownMonthly).toBe(500);
  });

  it("marks a node offline once it stops reporting", () => {
    const stale = server({ last_updated: NOW - 6 * 60_000, timestamp: NOW - 6 * 60_000 });

    expect(isServerOnline(stale, NOW)).toBe(false);
    expect(toNodeMetrics(stale, NOW).online).toBe(false);
  });

  it("reuses the previous ping object when nothing changed, to avoid re-renders", () => {
    const previous = toNodeMetrics(server(), NOW);
    const next = toNodeMetrics(server(), NOW, previous);

    expect(next.ping).toBe(previous.ping);
  });

  it("reads the backend's full timeout (ping null + loss 100) as a failed probe, not as no data", () => {
    // 后端 2026-09-07 起：false = 没配置（不显示），null + 丢包 100 = 这一轮全超时。
    const metrics = toNodeMetrics(
      server({ ping_ct: null, loss_ct: 100, ping_cu: false, loss_cu: false, ping_cm: 0, loss_cm: 0 }),
      NOW,
    );
    expect([metrics.ping.ct, metrics.ping.lossCt]).toEqual([PING_TIMEOUT_VALUE, 100]);
    expect([metrics.ping.cu, metrics.ping.lossCu]).toEqual([null, null]);
    // 0 ms / 0% 是有效数据，不能被当成超时或没数据。
    expect([metrics.ping.cm, metrics.ping.lossCm]).toEqual([0, 0]);
  });
});

describe("mergeServerPatch", () => {
  it("only overwrites the fields present in the incremental sample", () => {
    const base = server();
    const merged = mergeServerPatch(base, { cpu: 88, ram_used: 6000 }, NOW + 5_000);

    expect(merged.cpu).toBe(88);
    expect(merged.ram_used).toBe(6000);
    // 采样点没带的字段保持原值。
    expect(merged.disk_used).toBe(base.disk_used);
    expect(merged.tcp_conn).toBe(base.tcp_conn);
    expect(merged.last_updated).toBe(NOW + 5_000);
  });

  it("coerces string numbers coming off the wire", () => {
    const merged = mergeServerPatch(server(), { cpu: "42.5", net_in_speed: "999" }, NOW);

    expect(merged.cpu).toBe(42.5);
    expect(merged.net_in_speed).toBe(999);
  });

  it("returns the same object when the sample changes nothing", () => {
    const base = server();
    expect(mergeServerPatch(base, { cpu: base.cpu }, base.last_updated)).toBe(base);
  });

  it("accepts a null ping value as a real measurement gap", () => {
    const merged = mergeServerPatch(server(), { ping_ct: null }, NOW + 1_000);
    expect(merged.ping_ct).toBeNull();
  });

  it("normalises the four extra lines too, so a repeated `false` does not churn a new object", () => {
    const once = mergeServerPatch(server(), { ping_node_1: false, loss_node_1: false }, NOW + 1_000);
    expect(once.ping_node_1).toBeNull();
    expect(mergeServerPatch(once, { ping_node_1: false, loss_node_1: false }, NOW + 1_000)).toBe(once);
  });
});

describe("history conversion", () => {
  const row = HistoryRowSchema.parse({
    timestamp: NOW,
    cpu: 20,
    ram_total: 8192,
    ram_used: 2048,
    swap_total: 1024,
    swap_used: 64,
    disk_total: 102400,
    disk_used: 20480,
    processes: 120,
    net_in_speed: 2048,
    net_out_speed: 1024,
    tcp_conn: 30,
    udp_conn: 4,
    ping_ct: 23,
    ping_cu: null,
    ping_cm: 30,
    ping_bd: -1,
    loss_ct: 0,
    loss_cm: 50,
    load_avg: "0.50 0.40 0.30",
  });

  it("converts a history row into chart units", () => {
    const record = historyRowToLoadRecord(row, "node-a");

    expect(record.ram).toBe(2048 * MIB);
    expect(record.disk_total).toBe(102400 * MIB);
    expect(record.load).toBe(0.5);
    expect(record.connections).toBe(30);
    expect(record.time).toBe(NOW);
    // CF-Server-Monitor 历史不保存累计流量。
    expect(record.net_total_up).toBe(0);
    // 这一行没有磁盘 IO：保持 null，磁盘图才知道要退回已用空间。
    expect(record.disk_read).toBeNull();
    expect(record.disk_write).toBeNull();
  });

  it("reads disk IO from either the nested object or the flat fields", () => {
    const nested = historyRowToLoadRecord(
      HistoryRowSchema.parse({
        timestamp: NOW,
        disk: { read_bps: 4_000_000, write_bps: 1_500_000 },
      }),
      "node-a",
    );
    expect([nested.disk_read, nested.disk_write]).toEqual([4_000_000, 1_500_000]);

    const flat = historyRowToLoadRecord(
      HistoryRowSchema.parse({
        timestamp: NOW,
        disk_read_bps: 900_000,
        disk_write_bps: 0,
      }),
      "node-a",
    );
    // 写入 0 是「真的没在写」，不能当作缺数据。
    expect([flat.disk_read, flat.disk_write]).toEqual([900_000, 0]);
  });

  it("emits one ping record per measured carrier", () => {
    const records = historyRowsToPingRecords([row], "node-a");

    // 电信、移动有值；联通 null 且没有丢包 = 没取样，不产出；BD 的负值是探测失败，要产出（图表靠它画断点）。
    expect(records.map((record) => record.task_id)).toEqual([1, 3, 4]);
    expect(records[1]).toMatchObject({ value: 30, loss: 50, client: "node-a" });
    expect(records[2]).toMatchObject({ value: -1, loss: null });
  });

  it("keeps a timed-out round (ping null + loss 100) and still drops lines marked false", () => {
    const records = historyRowsToPingRecords(
      [
        HistoryRowSchema.parse({
          timestamp: NOW,
          ping_ct: null,
          loss_ct: 100,
          ping_cu: false,
          loss_cu: false,
          ping_cm: 31,
          loss_cm: 0,
        }),
      ],
      "node-a",
    );

    expect(records.map((record) => [record.task_id, record.value, record.loss])).toEqual([
      [1, PING_TIMEOUT_VALUE, 100],
      [3, 31, 0],
    ]);
  });

  it("names the eight carrier tasks", () => {
    expect(carrierPingTasks().map((task) => [task.id, task.name])).toEqual([
      [1, "电信"],
      [2, "联通"],
      [3, "移动"],
      [4, "BD"],
      [5, "Node 1"],
      [6, "Node 2"],
      [7, "Node 3"],
      [8, "Node 4"],
    ]);
  });

  it("reads the four extra lines the backend added in 2.8.5 Beta4", () => {
    // 窗口点用 node_1..4 这组键，当前值用 ping_node_1..4 / loss_node_1..4。
    const window = parseLatencyWindow(
      server({ ping: [{ ts: NOW, node_1: 12, node_4: 34 }], loss: [{ ts: NOW, node_1: 5 }] }),
    );
    expect(window[0]?.ping.node_1).toBe(12);
    expect(window[0]?.ping.node_4).toBe(34);
    expect(window[0]?.ping.lossNode1).toBe(5);
    expect(window[0]?.ping.node_2).toBeNull();
  });

  it("reads a timed-out window slot as a timeout, not as a missing value", () => {
    const window = parseLatencyWindow(
      server({
        ping: [{ ts: NOW, ct: null, cu: false, cm: 28 }],
        loss: [{ ts: NOW, ct: 100, cu: false, cm: 0 }],
      }),
    );
    expect([window[0]?.ping.ct, window[0]?.ping.lossCt]).toEqual([PING_TIMEOUT_VALUE, 100]);
    expect(window[0]?.ping.cu).toBeNull();
    expect(window[0]?.ping.cm).toBe(28);
  });

  it("uses the site's custom carrier names when given", () => {
    const names = resolveCarrierNames({ ct: "CT", bd: "BGP", node_2: "东京" });

    expect(carrierPingTasks(names).map((task) => task.name)).toEqual([
      "CT",
      "联通",
      "移动",
      "BGP",
      "Node 1",
      "东京",
      "Node 3",
      "Node 4",
    ]);
    expect(carrierTaskName(1, names)).toBe("CT");
    expect(carrierTaskName(3, names)).toBe("移动");
  });
});

describe("resolveCarrierNames", () => {
  it("keeps the default names for anything the backend did not send", () => {
    // 老后端一条都不下发；新后端也可能只改其中一两条，剩下的不能被清空。
    expect(resolveCarrierNames(undefined)).toBe(DEFAULT_CARRIER_NAMES);
    expect(resolveCarrierNames({})).toBe(DEFAULT_CARRIER_NAMES);
    expect(resolveCarrierNames({ ct: "", cu: null, cm: 42, bd: "  " })).toBe(
      DEFAULT_CARRIER_NAMES,
    );
  });

  it("trims the customised names and leaves the rest alone", () => {
    expect(resolveCarrierNames({ cu: "  CU 联通 " })).toEqual({
      ...DEFAULT_CARRIER_NAMES,
      cu: "CU 联通",
    });
  });

  it("falls back to a placeholder for ids outside the four fixed carriers", () => {
    expect(carrierTaskName(9)).toBe("线路 #9");
  });
});

describe("parseLatencyWindow", () => {
  it("zips the ping and loss arrays together by timestamp", () => {
    const window = parseLatencyWindow(
      server({
        ping: [
          { ts: NOW - 120_000, ct: 23, cu: 25, cm: 30, bd: 40 },
          { ts: NOW, ct: 24, cu: 26, cm: null, bd: 42 },
        ],
        loss: [
          { ts: NOW - 120_000, ct: 0, cu: 0, cm: 0, bd: 0 },
          { ts: NOW, ct: 0, cu: 0, cm: 100, bd: 0 },
        ],
      }),
    );

    expect(window).toHaveLength(2);
    expect(window[0]).toEqual({
      time: NOW - 120_000,
      // 后四条线路（node_1..4）后端这次没给，读成 null。
      ping: {
        ...EMPTY_CARRIER_PING,
        ct: 23,
        cu: 25,
        cm: 30,
        bd: 40,
        lossCt: 0,
        lossCu: 0,
        lossCm: 0,
        lossBd: 0,
      },
    });
    // 延迟 null + 丢包 100 = 这一轮全超时（后端 2026-09-07 口径），读成超时而不是「没数据」。
    expect(window[1]?.ping.cm).toBe(PING_TIMEOUT_VALUE);
    expect(window[1]?.ping.lossCm).toBe(100);
  });

  it("treats a disabled carrier (false) as no measurement", () => {
    const window = parseLatencyWindow(
      server({ ping: [{ ts: NOW, ct: 23, cu: false, cm: 30, bd: 40 }] }),
    );

    expect(window[0]?.ping.ct).toBe(23);
    expect(window[0]?.ping.cu).toBeNull();
  });

  it("sorts points ascending and drops ones without a timestamp", () => {
    const window = parseLatencyWindow(
      server({
        ping: [
          { ts: NOW, ct: 30 },
          { ts: 0, ct: 99 },
          { ts: NOW - 240_000, ct: 20 },
        ],
      }),
    );

    expect(window.map((sample) => sample.ping.ct)).toEqual([20, 30]);
  });

  it("returns nothing for an older backend without the window fields", () => {
    expect(parseLatencyWindow(server())).toEqual([]);
    expect(parseLatencyWindow(server({ ping: [] }))).toEqual([]);
  });

  it("keeps points that have no matching loss entry", () => {
    const window = parseLatencyWindow(server({ ping: [{ ts: NOW, ct: 23 }] }));

    expect(window[0]?.ping.ct).toBe(23);
    expect(window[0]?.ping.lossCt).toBeNull();
  });
});

describe("inferIntervalSeconds", () => {
  it("uses the median gap between samples", () => {
    expect(inferIntervalSeconds([0, 60_000, 120_000, 180_000])).toBe(60);
  });

  it("is undefined without at least two distinct samples", () => {
    expect(inferIntervalSeconds([])).toBeUndefined();
    expect(inferIntervalSeconds([1000])).toBeUndefined();
  });
});
