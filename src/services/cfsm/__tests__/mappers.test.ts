import { describe, expect, it } from "vitest";
import { CfsmServerSchema, type CfsmServer } from "@/types/cfsm";
import {
  carrierPingTasks,
  parseLatencyWindow,
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
  });

  it("emits one ping record per measured carrier", () => {
    const records = historyRowsToPingRecords([row], "node-a");

    expect(records.map((record) => record.task_id)).toEqual([1, 3]);
    expect(records[1]).toMatchObject({ value: 30, loss: 50, client: "node-a" });
  });

  it("names the four carrier tasks", () => {
    expect(carrierPingTasks().map((task) => [task.id, task.name])).toEqual([
      [1, "电信"],
      [2, "联通"],
      [3, "移动"],
      [4, "BD"],
    ]);
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
      ping: { ct: 23, cu: 25, cm: 30, bd: 40, lossCt: 0, lossCu: 0, lossCm: 0, lossBd: 0 },
    });
    expect(window[1]?.ping.cm).toBeNull();
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
