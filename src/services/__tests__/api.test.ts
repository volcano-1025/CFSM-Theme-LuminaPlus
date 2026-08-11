// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHistoryCache,
  getLoadRecords,
  getMe,
  getPingOverview,
  getPingRecords,
  getPublic,
  getServersSnapshot,
  normalizeHistoryHours,
} from "@/services/api";
import { resetApiBaseCache } from "@/services/cfsm/config";
import { ApiRequestError } from "@/services/cfsm/http";

const ORIGIN = "https://status.example.com";

// Response 的 body 只能读一次，因此每次调用都要新建一个。
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 让每次 fetch 都拿到独立的响应对象。 */
function jsonReply(body: unknown, status = 200) {
  return async () => jsonResponse(body, status);
}

function serverPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-a",
    name: "Node A",
    server_group: "prod",
    region: "JP",
    is_hidden: "0",
    sort_order: 10,
    cpu: 12.5,
    load_avg: "0.10 0.20 0.30",
    net_in_speed: 1024,
    net_out_speed: 512,
    net_rx: 100,
    net_tx: 200,
    net_rx_monthly: 50,
    net_tx_monthly: 60,
    ram_total: 8192,
    ram_used: 4096,
    swap_total: 1024,
    swap_used: 128,
    disk_total: 102400,
    disk_used: 51200,
    cpu_cores: 4,
    cpu_info: "Intel Xeon",
    arch: "x86_64",
    os: "Ubuntu 22.04",
    kernel_version: "6.8.0",
    ip_v4: "1",
    ip_v6: "0",
    boot_time: "1700000000000",
    last_updated: Date.now(),
    timestamp: Date.now(),
    price: "30.00",
    currency: "¥",
    billing_cycle: "month",
    auto_renewal: "0",
    expire_date: "2026-12-31",
    traffic_limit: "1024",
    traffic_calc_type: "total",
    reset_day: 1,
    report_interval: 60,
    tags: "prod,edge",
    ...overrides,
  };
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: Date.parse("2026-07-16T00:00:00Z"),
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
    ping_cu: 25,
    ping_cm: 30,
    ping_bd: 40,
    loss_ct: 0,
    loss_cu: 0,
    loss_cm: 0,
    loss_bd: 0,
    load_avg: "0.50 0.40 0.30",
    kernel_version: "6.8.0",
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetApiBaseCache();
  clearHistoryCache();
  window.localStorage.clear();
  document.head.innerHTML = "";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeHistoryHours", () => {
  it("snaps arbitrary durations to a supported step", () => {
    expect(normalizeHistoryHours(4)).toBe(6);
    expect(normalizeHistoryHours(0.2)).toBe(0.167);
    expect(normalizeHistoryHours(1000)).toBe(168);
    expect(normalizeHistoryHours(Number.NaN)).toBe(24);
  });
});

describe("getPublic", () => {
  it("maps /api/config into the theme's display model", async () => {
    fetchMock.mockImplementation(
      jsonReply({
        version: "2.7.12",
        is_public: false,
        authorization: true,
        turnstile_enabled: true,
        turnstile_site_key: "key",
        site_title: "My Monitor",
        theme_options: { showConnections: false },
        verified: true,
        long_history_points: 180,
      }),
    );

    const config = await getPublic();

    expect(config.sitename).toBe("My Monitor");
    expect(config.private_site).toBe(true);
    expect(config.theme_settings).toEqual({ showConnections: false });
    expect(config.sys.long_history_points).toBe(180);
  });

  it("caches the encrypted turnstile credential for reuse", async () => {
    fetchMock.mockImplementation(
      jsonReply({ site_title: "S", turnstile_verified: "cred-1" }),
    );

    await getPublic();

    expect(window.localStorage.getItem("turnstile_verified")).toBe("cred-1");
  });

  it("surfaces the backend error message", async () => {
    fetchMock.mockImplementation(jsonReply({ error: "Missing ID", code: 400 }, 400));

    await expect(getPublic()).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe("getMe", () => {
  it("reports a logged-out visitor without hitting the network", async () => {
    const me = await getMe();

    expect(me.logged_in).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives the login state from config.authorization", async () => {
    window.localStorage.setItem("jwt_token", "token");
    fetchMock.mockImplementation(jsonReply({ authorization: true, site_title: "S" }));

    await expect(getMe()).resolves.toMatchObject({ logged_in: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("drops an expired token on 401 so later requests go out anonymously", async () => {
    window.localStorage.setItem("jwt_token", "stale");
    fetchMock.mockImplementation(jsonReply({ error: "Unauthorized", code: 401 }, 401));

    await expect(getMe()).rejects.toBeInstanceOf(ApiRequestError);
    expect(window.localStorage.getItem("jwt_token")).toBeNull();
  });
});

describe("getServersSnapshot", () => {
  it("returns the server list with its owning API base", async () => {
    fetchMock.mockImplementation(
      jsonReply({
        servers: [serverPayload()],
        stats: { total: 1, online: 1 },
        regionStats: { JP: 1 },
        sysConfig: { show_price: false, show_expire: true, show_tf: true, show_time: true },
      }),
    );

    const snapshot = await getServersSnapshot();

    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.baseByServerId.get("node-a")).toBe(window.location.origin);
    expect(snapshot.sysConfig.show_price).toBe(false);
    expect(snapshot.partial).toBe(false);
  });

  it("merges multiple api bases and marks a partial result when one fails", async () => {
    const meta = document.createElement("meta");
    meta.name = "apiBase";
    meta.content = `${ORIGIN},https://backup.example.com`;
    document.head.append(meta);
    resetApiBaseCache();

    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith(ORIGIN)) {
        return jsonResponse({
          servers: [serverPayload()],
          stats: { total: 1, online: 1 },
          regionStats: { JP: 1 },
          sysConfig: {},
        });
      }
      return jsonResponse({ error: "boom", code: 500 }, 500);
    });

    const snapshot = await getServersSnapshot();

    expect(snapshot.servers.map((server) => server.id)).toEqual(["node-a"]);
    expect(snapshot.baseByServerId.get("node-a")).toBe(ORIGIN);
    expect(snapshot.partial).toBe(true);
  });

  it("throws when every api base fails", async () => {
    fetchMock.mockImplementation(jsonReply({ error: "boom", code: 500 }, 500));

    await expect(getServersSnapshot()).rejects.toBeInstanceOf(Error);
  });
});

describe("getLoadRecords", () => {
  it("converts history rows into chart records with byte units", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow()]));

    const { records } = await getLoadRecords("node-a", 6);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cpu: 20,
      ram: 2048 * 1024 * 1024,
      ram_total: 8192 * 1024 * 1024,
      net_in: 2048,
      net_out: 1024,
      load: 0.5,
      client: "node-a",
    });
  });

  it("sorts rows ascending and infers the sampling interval", async () => {
    const base = Date.parse("2026-07-16T00:00:00Z");
    fetchMock.mockImplementation(
      jsonReply([
        historyRow({ timestamp: base + 120_000 }),
        historyRow({ timestamp: base }),
        historyRow({ timestamp: base + 60_000 }),
      ]),
    );

    const { records, intervalSeconds } = await getLoadRecords("node-a", 1);

    expect(records.map((record) => record.time)).toEqual([
      base,
      base + 60_000,
      base + 120_000,
    ]);
    expect(intervalSeconds).toBe(60);
  });

  it("requests a backend-supported hours value", async () => {
    fetchMock.mockImplementation(jsonReply([]));

    await getLoadRecords("node-a", 4);

    expect(String(fetchMock.mock.calls[0]![0])).toContain("hours=6");
  });
});

describe("getPingRecords", () => {
  it("splits each history row into the four carrier lines", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow()]));

    const { records, tasks, stats } = await getPingRecords("node-a", 6);

    expect(records.map((record) => record.task_id)).toEqual([1, 2, 3, 4]);
    expect(records.map((record) => record.value)).toEqual([23, 25, 30, 40]);
    expect(tasks.map((task) => task.name)).toEqual(["电信", "联通", "移动", "BD"]);
    expect(stats?.find((stat) => stat.taskId === 1)?.avg).toBe(23);
  });

  it("skips carriers with no measurement", async () => {
    fetchMock.mockImplementation(
      jsonReply([historyRow({ ping_cu: null, ping_bd: -1 })]),
    );

    const { records } = await getPingRecords("node-a", 6);

    expect(records.map((record) => record.task_id)).toEqual([1, 3]);
  });
});

describe("getPingOverview", () => {
  it("fetches each node once and filters to the requested carrier", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow()]));

    const overview = await getPingOverview(1, 2, { entityIds: ["node-a", "node-b"] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(overview.records.every((record) => record.task_id === 2)).toBe(true);
    expect(overview.records.map((record) => record.client).sort()).toEqual([
      "node-a",
      "node-b",
    ]);
  });

  it("serves the other carriers from cache instead of refetching", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow()]));

    await getPingOverview(1, 1, { entityIds: ["node-a"] });
    await getPingOverview(1, 3, { entityIds: ["node-a"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps working when one node's history fails", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("node-b")
        ? jsonResponse({ error: "boom", code: 500 }, 500)
        : jsonResponse([historyRow()]),
    );

    const overview = await getPingOverview(1, 1, { entityIds: ["node-a", "node-b"] });

    expect(overview.records.map((record) => record.client)).toEqual(["node-a"]);
  });
});
