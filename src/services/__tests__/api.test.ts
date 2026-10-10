// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHistoryCache,
  getLoadRecords,
  resolveMe,
  getPingRecords,
  getPublic,
  getServerApiBase,
  getServersSnapshot,
  normalizeHistoryHours,
  resetRecentThemeOptionsWrite,
  saveThemeOptions,
} from "@/services/api";
import {
  resetApiBaseCache,
  subscribeTurnstileCredentialsCleared,
} from "@/services/cfsm/config";
import { DEFAULT_CARRIER_NAMES } from "@/services/cfsm/mappers";
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
  resetRecentThemeOptionsWrite();
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

  it("carries latency_window through so cards can size the ping window", async () => {
    fetchMock.mockImplementation(
      jsonReply({ site_title: "S", latency_window: { points: 20, hours: 2 } }),
    );

    const config = await getPublic();

    expect(config.latencyWindow).toEqual({ points: 20, hours: 2 });
  });

  it("leaves latencyWindow undefined when the backend omits it (older backends)", async () => {
    fetchMock.mockImplementation(jsonReply({ site_title: "S" }));

    const config = await getPublic();

    expect(config.latencyWindow).toBeUndefined();
  });

  it("takes the carrier names the backend customised", async () => {
    fetchMock.mockImplementation(
      jsonReply({
        site_title: "S",
        custom_ct_name: "CT",
        custom_cu_name: "CU",
        custom_cm_name: "CM",
        custom_bd_name: "BGP",
      }),
    );

    const config = await getPublic();

    expect(config.carrierNames).toEqual({
      ...DEFAULT_CARRIER_NAMES,
      ct: "CT",
      cu: "CU",
      cm: "CM",
      bd: "BGP",
    });
  });

  it("takes the four extra line names the backend added (node_N_name)", async () => {
    // 后四条的键名风格和前四条不一样（node_N_name，不是 custom_*_name），别只接前四条。
    fetchMock.mockImplementation(
      jsonReply({
        site_title: "S",
        node_1_name: "东京",
        node_3_name: "法兰克福",
      }),
    );

    const config = await getPublic();

    expect(config.carrierNames).toEqual({
      ...DEFAULT_CARRIER_NAMES,
      node_1: "东京",
      node_3: "法兰克福",
    });
  });

  it("falls back per carrier when only some names are customised", async () => {
    // 老后端一个都不下发、新后端也可能只改一两条：没给的那几条必须留默认名，不能变空。
    fetchMock.mockImplementation(
      jsonReply({ site_title: "S", custom_bd_name: "BGP", custom_cm_name: "  " }),
    );

    const config = await getPublic();

    expect(config.carrierNames).toEqual({
      ...DEFAULT_CARRIER_NAMES,
      bd: "BGP",
    });
  });

  it("keeps the default carrier names when the backend omits the fields", async () => {
    fetchMock.mockImplementation(jsonReply({ site_title: "S" }));

    const config = await getPublic();

    expect(config.carrierNames).toEqual(DEFAULT_CARRIER_NAMES);
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

describe("resolveMe", () => {
  it("reports a logged-out visitor without waiting for the config", () => {
    expect(resolveMe(undefined)).toMatchObject({ logged_in: false });
    expect(resolveMe({ authorization: true })).toMatchObject({ logged_in: false });
  });

  it("derives the login state from config.authorization, without a request of its own", () => {
    window.localStorage.setItem("jwt_token", "token");

    expect(resolveMe(undefined)).toBeUndefined();
    expect(resolveMe({ authorization: true })).toMatchObject({ logged_in: true });
    expect(resolveMe({ authorization: false })).toMatchObject({ logged_in: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops an expired token on 401 so later requests go out anonymously", async () => {
    window.localStorage.setItem("jwt_token", "stale");
    fetchMock.mockImplementation(jsonReply({ error: "Unauthorized", code: 401 }, 401));

    await expect(getPublic()).rejects.toBeInstanceOf(ApiRequestError);
    expect(window.localStorage.getItem("jwt_token")).toBeNull();
  });
});

describe("saveThemeOptions", () => {
  it("POSTs { theme_options } as JSON with the admin bearer + turnstile headers", async () => {
    window.localStorage.setItem("jwt_token", "token");
    window.localStorage.setItem("turnstile_verified", "cached-cred");
    fetchMock.mockImplementation(
      jsonReply({ success: true, theme_options: { accent: "green" }, message: "updateSuccess" }),
    );

    const res = await saveThemeOptions({ accent: "green" });

    expect(res).toMatchObject({ success: true, message: "updateSuccess" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/theme_options");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Turnstile-Verified"]).toBe("cached-cred");
    expect(JSON.parse(init.body as string)).toEqual({ theme_options: { accent: "green" } });
  });

  it("trusts its own write over a stale /api/config for a couple of minutes", async () => {
    // 后端每个 isolate 各缓存 120 秒站点设置：保存后紧接着的读取可能拿回旧的一份。
    window.localStorage.setItem("jwt_token", "token");
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/api/theme_options")
        ? jsonResponse({ success: true, theme_options: { accent: "green" }, message: "updateSuccess" })
        : jsonResponse({ site_title: "S", theme_options: { accent: "stale" } }),
    );
    const savedAt = Date.now();

    await saveThemeOptions({ accent: "green" });
    expect((await getPublic()).theme_settings).toEqual({ accent: "green" });

    vi.spyOn(Date, "now").mockReturnValue(savedAt + 3 * 60_000);
    expect((await getPublic()).theme_settings).toEqual({ accent: "stale" });
  });

  it("drops the expired token on 401 (writes have no anonymous fallback)", async () => {
    window.localStorage.setItem("jwt_token", "stale");
    fetchMock.mockImplementation(jsonReply({ error: "Unauthorized", code: 401 }, 401));

    await expect(saveThemeOptions({ accent: "green" })).rejects.toBeInstanceOf(ApiRequestError);
    expect(window.localStorage.getItem("jwt_token")).toBeNull();
  });

  it("clears turnstile credentials on 403 so the gate re-challenges", async () => {
    window.localStorage.setItem("jwt_token", "token");
    window.localStorage.setItem("turnstile_verified", "cached-cred");
    fetchMock.mockImplementation(jsonReply({ error: "forbidden", code: 403 }, 403));

    await expect(saveThemeOptions({ accent: "green" })).rejects.toBeInstanceOf(ApiRequestError);
    expect(window.localStorage.getItem("turnstile_verified")).toBeNull();
  });
});

describe("Turnstile 凭证过期", () => {
  it("tells the gate once when a 403 actually clears a credential", async () => {
    // 首页轮询拿着过期凭证被拒：弹窗要靠这次通知去重新拉 config，缓存里那份还写着 verified: true。
    window.localStorage.setItem("turnstile_verified", "expired-cred");
    fetchMock.mockImplementation(jsonReply({ error: "Turnstile verification failed", code: 403 }, 403));
    const onCleared = vi.fn();
    const unsubscribe = subscribeTurnstileCredentialsCleared(onCleared);

    await expect(getServersSnapshot()).rejects.toBeInstanceOf(ApiRequestError);
    expect(onCleared).toHaveBeenCalledTimes(1);

    // 凭证已经没了，之后每一次 403 都不再通知（否则 5 秒一次的轮询会跟着一直重拉 config）。
    await expect(getServersSnapshot()).rejects.toBeInstanceOf(ApiRequestError);
    expect(onCleared).toHaveBeenCalledTimes(1);

    unsubscribe();
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

  it("records when the backend last heard from each node", async () => {
    // `servers[].last_updated` 是探针时钟打的样本时间；`latestReportUpdates[].reportTs` 才是后端收到的时刻。
    fetchMock.mockImplementation(
      jsonReply({
        servers: [serverPayload({ id: "node-a" }), serverPayload({ id: "node-b" })],
        latestReportUpdates: [{ serverId: "node-a", reportTs: 1_791_626_976_459, samples: [] }],
      }),
    );

    const snapshot = await getServersSnapshot();

    expect(snapshot.servers.find((item) => item.id === "node-a")?.report_timestamp).toBe(
      1_791_626_976_459,
    );
    expect(snapshot.servers.find((item) => item.id === "node-b")?.report_timestamp).toBeUndefined();
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
    expect(snapshot.failedBases).toEqual(["https://backup.example.com"]);
  });

  it("routes detail requests for a duplicated id to the site whose card is shown", async () => {
    const meta = document.createElement("meta");
    meta.name = "apiBase";
    meta.content = `${ORIGIN},https://backup.example.com`;
    document.head.append(meta);
    resetApiBaseCache();

    fetchMock.mockImplementation(async () =>
      jsonResponse({
        servers: [serverPayload({ id: "node-dup" })],
        stats: { total: 1, online: 1 },
        regionStats: {},
        sysConfig: {},
      }),
    );

    const snapshot = await getServersSnapshot();

    // 卡片与 WS 用第一个站的那台；详情 / 历史必须打到同一个站，不能被第二个站的同名 ID 覆盖。
    expect(snapshot.baseByServerId.get("node-dup")).toBe(ORIGIN);
    expect(getServerApiBase("node-dup")).toBe(ORIGIN);
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

  it("skips carriers with no measurement, but keeps failed probes", async () => {
    fetchMock.mockImplementation(
      jsonReply([historyRow({ ping_cu: null, ping_bd: -1 })]),
    );

    const { records } = await getPingRecords("node-a", 6);

    // 联通 null 且丢包不是正数 = 没取样，跳过；BD 负值 = 探测失败，要留着（图表靠它画断点、算丢包）。
    expect(records.map((record) => record.task_id)).toEqual([1, 3, 4]);
    expect(records.find((record) => record.task_id === 4)?.value).toBe(-1);
  });

  it("keeps timed-out probes out of the latency stats, but counts them as loss", async () => {
    const base = Date.parse("2026-07-16T00:00:00Z");
    fetchMock.mockImplementation(
      jsonReply([
        historyRow({ timestamp: base, ping_ct: 20 }),
        historyRow({ timestamp: base + 30_000, ping_ct: 30 }),
        // 最后一轮整轮超时：详情页线路按钮上的「当前」曾经因此显示成「-1.0 ms」。
        historyRow({ timestamp: base + 60_000, ping_ct: null, loss_ct: 100 }),
      ]),
    );

    const { stats } = await getPingRecords("node-a", 1);
    const ct = stats?.find((stat) => stat.taskId === 1);

    expect(ct).toMatchObject({ latest: 30, min: 20, max: 30, avg: 25, valid: 2, total: 3 });
    expect(ct?.loss).toBeCloseTo(100 / 3, 5);
  });

  it("still lists a line whose every probe timed out", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow({ ping_ct: null, loss_ct: 100 })]));

    const { stats } = await getPingRecords("node-a", 1);

    expect(stats?.find((stat) => stat.taskId === 1)).toMatchObject({
      latest: null,
      min: null,
      avg: null,
      valid: 0,
      total: 1,
      loss: 100,
    });
  });

  it("drops lines the backend marks as unconfigured with false, new ones included", async () => {
    // 后端对没配探测目标的槽位下发 false（2026-09-09 实测，历史行与快照都是这样），
    // 站长的要求是「ping_x / loss_x 不存在就不展示」——包括老的 ping_bd。
    fetchMock.mockImplementation(
      jsonReply([
        historyRow({
          ping_bd: false as unknown as number,
          ping_node_1: 42,
          ping_node_2: false as unknown as number,
          ping_node_3: null,
        }),
      ]),
    );

    const { records, tasks } = await getPingRecords("node-a", 6);

    // 1/2/3 有值，5 = node_1 有值；4(bd) / 6(node_2) / 7(node_3) / 8(node_4) 都不产出点。
    expect([...new Set(records.map((record) => record.task_id))]).toEqual([1, 2, 3, 5]);
    // 详情页图表只画 tasks 里的线路，所以没数据的那几条根本不会出现在图例里。
    expect(tasks.map((task) => task.id)).toEqual([1, 2, 3, 5]);
  });
});

