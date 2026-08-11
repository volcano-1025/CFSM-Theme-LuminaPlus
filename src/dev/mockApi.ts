/**
 * 开发用的假后端：拦截 fetch，按 CF-Server-Monitor 的公开 API 形状返回数据。
 * 通过 `?mock=1` 启用，只在 dev 构建里被引入。
 *
 * WebSocket 不做模拟——连接失败后 store 会自动降级为轮询，正好覆盖降级路径。
 */

interface MockServer {
  id: string;
  name: string;
  server_group: string;
  region: string;
  os: string;
  arch: string;
  cpu_info: string;
  cpu_cores: number;
  kernel_version: string;
  /** MiB */
  ram_total: number;
  swap_total: number;
  disk_total: number;
  price: string;
  currency: string;
  billing_cycle: string;
  auto_renewal: string;
  expire_date: string;
  /** GB */
  traffic_limit: string;
  traffic_calc_type: string;
  reset_day: number;
  tags: string;
  sort_order: number;
  is_hidden: "0" | "1";
  gpu?: string;
  offline?: boolean;
}

function daysFromNow(days: number) {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

const SERVERS: MockServer[] = [
  {
    id: "tokyo-edge-01",
    name: "Tokyo Edge",
    server_group: "生产",
    region: "JP",
    os: "Debian 12",
    arch: "x86_64",
    cpu_info: "AMD EPYC 7B13",
    cpu_cores: 4,
    kernel_version: "6.1.0-18-amd64",
    ram_total: 8 * 1024,
    swap_total: 2 * 1024,
    disk_total: 160 * 1024,
    price: "48.00",
    currency: "¥",
    billing_cycle: "month",
    auto_renewal: "1",
    expire_date: daysFromNow(24),
    traffic_limit: "4096",
    traffic_calc_type: "total",
    reset_day: 1,
    tags: "边缘,高带宽",
    sort_order: 10,
    is_hidden: "0",
  },
  {
    id: "hk-api-02",
    name: "HK API",
    server_group: "生产",
    region: "HK",
    os: "Ubuntu 22.04",
    arch: "x86_64",
    cpu_info: "Intel Xeon Platinum 8375C",
    cpu_cores: 8,
    kernel_version: "5.15.0-91-generic",
    ram_total: 16 * 1024,
    swap_total: 0,
    disk_total: 320 * 1024,
    price: "128.00",
    currency: "¥",
    billing_cycle: "year",
    auto_renewal: "0",
    expire_date: daysFromNow(6),
    traffic_limit: "1024",
    traffic_calc_type: "max",
    reset_day: 15,
    tags: "API",
    sort_order: 20,
    is_hidden: "0",
    gpu: '[{"id":"0","name":"NVIDIA RTX 3060","info":42.5}]',
  },
  {
    id: "fra-build-03",
    name: "Frankfurt Build",
    server_group: "构建",
    region: "DE",
    os: "Alpine Linux 3.19",
    arch: "aarch64",
    cpu_info: "Ampere Altra",
    cpu_cores: 2,
    kernel_version: "6.6.4-0-lts",
    ram_total: 4 * 1024,
    swap_total: 1024,
    disk_total: 80 * 1024,
    price: "0",
    currency: "$",
    billing_cycle: "month",
    auto_renewal: "0",
    expire_date: "",
    traffic_limit: "",
    traffic_calc_type: "total",
    reset_day: 1,
    tags: "CI",
    sort_order: 30,
    is_hidden: "0",
  },
  {
    id: "sg-backup-04",
    name: "Singapore Backup",
    server_group: "备份",
    region: "SG",
    os: "OpenWrt 23.05",
    arch: "x86_64",
    cpu_info: "Intel N100",
    cpu_cores: 4,
    kernel_version: "5.15.137",
    ram_total: 8 * 1024,
    swap_total: 0,
    disk_total: 2048 * 1024,
    price: "19.90",
    currency: "$",
    billing_cycle: "quarter",
    auto_renewal: "1",
    expire_date: daysFromNow(-3),
    traffic_limit: "512",
    traffic_calc_type: "dl",
    reset_day: 5,
    tags: "冷备",
    sort_order: 40,
    is_hidden: "0",
    offline: true,
  },
];

function wave(seed: number, period: number, amplitude: number, offset: number) {
  return offset + Math.sin((Date.now() / period) * (1 + seed * 0.17)) * amplitude;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildServerPayload(server: MockServer, index: number) {
  const now = Date.now();
  const offline = server.offline === true;
  const cpu = offline ? 0 : clamp(wave(index, 24_000, 28, 34), 0, 100);
  const ramUsed = offline ? 0 : Math.round(server.ram_total * clamp(wave(index, 41_000, 0.18, 0.52), 0.05, 0.95));
  const diskUsed = Math.round(server.disk_total * (0.3 + index * 0.12));

  return {
    id: server.id,
    name: server.name,
    server_group: server.server_group,
    tags: server.tags,
    price: server.price,
    billing_cycle: server.billing_cycle,
    auto_renewal: server.auto_renewal,
    currency: server.currency,
    expire_date: server.expire_date,
    traffic_limit: server.traffic_limit,
    traffic_calc_type: server.traffic_calc_type,
    reset_day: server.reset_day,
    report_interval: 60,
    is_hidden: server.is_hidden,
    sort_order: server.sort_order,

    cpu,
    load_avg: offline ? "0.00 0.00 0.00" : `${(cpu / 100 * server.cpu_cores).toFixed(2)} ${(cpu / 130 * server.cpu_cores).toFixed(2)} ${(cpu / 160 * server.cpu_cores).toFixed(2)}`,
    net_in_speed: offline ? 0 : Math.round(clamp(wave(index, 9_000, 4_000_000, 5_200_000), 0, 2e8)),
    net_out_speed: offline ? 0 : Math.round(clamp(wave(index + 3, 11_000, 2_400_000, 3_100_000), 0, 2e8)),
    net_rx: 4.2e12 + index * 3.1e11,
    net_tx: 2.6e12 + index * 1.7e11,
    net_rx_monthly: 3.1e11 + index * 8.4e10,
    net_tx_monthly: 1.9e11 + index * 5.2e10,
    processes: offline ? 0 : 120 + index * 37,
    tcp_conn: offline ? 0 : 48 + index * 19,
    udp_conn: offline ? 0 : 6 + index * 3,

    ping_ct: offline ? null : Math.round(clamp(wave(index, 33_000, 12, 38), 1, 400)),
    ping_cu: offline ? null : Math.round(clamp(wave(index + 1, 29_000, 18, 52), 1, 400)),
    ping_cm: offline ? null : Math.round(clamp(wave(index + 2, 37_000, 26, 74), 1, 400)),
    ping_bd: offline ? null : Math.round(clamp(wave(index + 4, 31_000, 9, 21), 1, 400)),
    loss_ct: offline ? null : 0,
    loss_cu: offline ? null : index === 1 ? 4 : 0,
    loss_cm: offline ? null : 0,
    loss_bd: offline ? null : 0,

    ram_total: server.ram_total,
    ram_used: ramUsed,
    swap_total: server.swap_total,
    swap_used: offline ? 0 : Math.round(server.swap_total * 0.12),
    disk_total: server.disk_total,
    disk_used: diskUsed,
    disk: offline
      ? undefined
      : {
          read_bps: Math.round(clamp(wave(index, 13_000, 3e6, 4e6), 0, 5e8)),
          write_bps: Math.round(clamp(wave(index + 2, 17_000, 1e6, 2e6), 0, 5e8)),
          read_iops: 42 + index * 11,
          write_iops: 18 + index * 7,
          await_ms: 1.2 + index * 0.3,
          util: clamp(wave(index, 21_000, 12, 18), 0, 100),
        },

    cpu_cores: server.cpu_cores,
    cpu_info: server.cpu_info,
    gpu_info: server.gpu ?? "",
    arch: server.arch,
    os: server.os,
    kernel_version: server.kernel_version,
    region: server.region,
    ip_v4: "1",
    ip_v6: index % 2 === 0 ? "1" : "0",
    boot_time: String(now - (index + 1) * 86_400_000 * 9),
    agent_version: "1.3.3",
    last_updated: offline ? now - 40 * 60_000 : now,
    timestamp: offline ? now - 40 * 60_000 : now,
  };
}

function buildHistory(serverId: string, hours: number) {
  const index = Math.max(0, SERVERS.findIndex((server) => server.id === serverId));
  const server = SERVERS[index];
  if (!server) return [];

  const points = 120;
  const now = Date.now();
  const stepMs = (hours * 3_600_000) / points;
  const rows = [];
  for (let i = points; i >= 0; i--) {
    const timestamp = now - i * stepMs;
    const phase = (i / points) * Math.PI * 4 + index;
    rows.push({
      timestamp,
      cpu: clamp(34 + Math.sin(phase) * 26, 0, 100),
      gpu_info: server.gpu ?? "",
      ram_total: server.ram_total,
      ram_used: Math.round(server.ram_total * clamp(0.52 + Math.sin(phase / 2) * 0.18, 0.05, 0.95)),
      swap_total: server.swap_total,
      swap_used: Math.round(server.swap_total * 0.12),
      disk_total: server.disk_total,
      disk_used: Math.round(server.disk_total * (0.3 + index * 0.12)),
      disk: {
        read_bps: Math.round(clamp(4e6 + Math.sin(phase) * 3e6, 0, 5e8)),
        write_bps: Math.round(clamp(2e6 + Math.cos(phase) * 1e6, 0, 5e8)),
        read_iops: 42,
        write_iops: 18,
        await_ms: 1.4,
        util: clamp(18 + Math.sin(phase) * 12, 0, 100),
      },
      processes: 120 + index * 37,
      net_in_speed: Math.round(clamp(5.2e6 + Math.sin(phase) * 4e6, 0, 2e8)),
      net_out_speed: Math.round(clamp(3.1e6 + Math.cos(phase) * 2.4e6, 0, 2e8)),
      tcp_conn: 48 + index * 19,
      udp_conn: 6 + index * 3,
      ping_ct: Math.round(clamp(38 + Math.sin(phase) * 12, 1, 400)),
      ping_cu: Math.round(clamp(52 + Math.sin(phase + 1) * 18, 1, 400)),
      ping_cm: Math.round(clamp(74 + Math.sin(phase + 2) * 26, 1, 400)),
      ping_bd: Math.round(clamp(21 + Math.sin(phase + 3) * 9, 1, 400)),
      loss_ct: 0,
      loss_cu: i % 17 === 0 ? 20 : 0,
      loss_cm: 0,
      loss_bd: 0,
      load_avg: "0.42 0.38 0.31",
      kernel_version: server.kernel_version,
    });
  }
  return rows;
}

export function installDevMockApi() {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      window.location.origin,
    );

    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (url.pathname === "/api/config") {
      return json({
        version: "2.7.12 Beta",
        is_public: true,
        authorization: false,
        turnstile_enabled: false,
        turnstile_login_enabled: false,
        turnstile_site_key: "",
        site_title: "Mock Monitor",
        display_mode: "bar",
        theme_options: {},
        verified: false,
        turnstile_verified: null,
        long_history_points: 120,
      });
    }

    if (url.pathname === "/api/servers") {
      const servers = SERVERS.map((server, index) => buildServerPayload(server, index));
      const online = servers.filter((server) => Date.now() - server.last_updated < 300_000);
      return json({
        servers,
        latestReportUpdates: [],
        stats: {
          total: servers.length,
          online: online.length,
          offline: servers.length - online.length,
          globalSpeedIn: online.reduce((sum, server) => sum + server.net_in_speed, 0),
          globalSpeedOut: online.reduce((sum, server) => sum + server.net_out_speed, 0),
          globalNetRx: servers.reduce((sum, server) => sum + server.net_rx, 0),
          globalNetTx: servers.reduce((sum, server) => sum + server.net_tx, 0),
        },
        regionStats: servers.reduce<Record<string, number>>((acc, server) => {
          acc[server.region] = (acc[server.region] ?? 0) + 1;
          return acc;
        }, {}),
        sysConfig: {
          show_price: true,
          show_expire: true,
          show_tf: true,
          show_time: true,
          display_mode: "bar",
        },
      });
    }

    if (url.pathname === "/api/server") {
      const id = url.searchParams.get("id") ?? "";
      const index = SERVERS.findIndex((server) => server.id === id);
      if (index < 0) {
        return new Response(JSON.stringify({ error: "Server not found", code: 404 }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json({
        ...buildServerPayload(SERVERS[index]!, index),
        latestReportUpdates: [],
        sysConfig: { long_history_points: 120 },
      });
    }

    if (url.pathname === "/api/history/all") {
      const id = url.searchParams.get("id") ?? "";
      const hours = Number.parseFloat(url.searchParams.get("hours") ?? "24") || 24;
      return json(buildHistory(id, hours));
    }

    return nativeFetch(input, init);
  };

  console.info(`[LuminaPlus] dev mock API enabled (${SERVERS.length} servers)`);
}
