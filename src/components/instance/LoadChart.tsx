import { t, type MessageKey } from "@/i18n";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import UplotReact from "uplot-react";
import uPlot from "uplot";
import { ArrowDown, ArrowUp, Cpu, Gauge, HardDrive, Layers, MemoryStick, Network, RefreshCw, Workflow } from "lucide-react";
import { useLoadRecords } from "@/hooks/useRecords";
import { useNodeMeta, useNodeMetrics } from "@/hooks/useNode";
import { InstancePanel, InstanceChartLoading } from "./InstancePanel";
import {
  buildChartTooltipHooks,
  SPARSE_SERIES_POINTS,
  axisDecimals,
  chartAlpha,
  zeroBasedTicks,
  createTimeAxisFormatter,
  formatChartCoverageTime,
  getAxisColors,
  toChartSeconds,
  useResponsiveChartSize,
  type ChartTooltipState,
} from "./chartShared";
import { ChartTooltip, SwitchToggle } from "./ChartParts";
import {
  downsampleAligned,
  appendLiveChartPoint,
  fillMissingMetricPoints,
  interpolateMetricGaps,
  mergeHistoryWithLivePoints,
  resampleLiveTail,
} from "./chartData";
import { formatByteRateLabel, formatBytes, formatTrafficRateLabel } from "@/utils/format";
import { historyChartRangeSeconds, historyCoverageLabel } from "@/utils/historyRange";
import { resolveLoadRecordTotals } from "@/utils/loadMetrics";
import { usePreferences } from "@/hooks/usePreferences";
import { useMetricColorsVersion } from "@/hooks/useMetricColors";
import { safeCanvasColor } from "@/components/node/CanvasStrip";
import type { LoadRecord, NodeMetrics } from "@/types/cfsm";

const LOAD_HISTORY_SAMPLE_LIMIT = 360;
const LOAD_HISTORY_RENDER_LIMIT = 720;
/**
 * 「实时」档查 10 分钟档历史打底（后端认的最短档位），不再查整整一小时。
 *
 * 每个档位都会把实时样本接在历史后面之后（v1.2.18），「实时」要是还拿一小时打底，
 * 它和「1 小时」画出来就是同一张图（站长 2026-09-21：「这个实时和 1 小时都是 1 小时的数据」）。
 */
const REALTIME_QUERY_HOURS = 0.167;
/** 打底的行数上限：10 分钟按 30 秒一行约 20 行，留点余量给上报更密的探针。 */
const REALTIME_HISTORY_SEED_LIMIT = 60;
/**
 * 「实时」档最多显示这么长的一段。按**时间**卡而不是只按条数：探针 60 秒才报一次时，
 * 600 条就是 10 小时，那又变回「长区间」了。
 */
const REALTIME_WINDOW_SECONDS = 15 * 60;
const REALTIME_SAMPLE_LIMIT = 600;
/**
 * 「实时」档把实时样本按这个格宽合并（保峰）。原样 2 秒一个点时，比打底的历史（10 分钟档约 30 秒一行）密 15 倍，
 * 挤成一团锯齿（站长 2026-10-07 截图）；10 秒一格时 15 分钟约 90 个点，仍比历史细 3 倍、短尖峰留得住（站长选的）。
 */
const REALTIME_LIVE_STEP_SECONDS = 10;
/**
 * 回到前台、且离开超过这么久就把历史重拉一次。
 *
 * 页面在后台时实时推送是断开的（见 wsStore 的后台暂停），这段时间的数据只在后端的历史里，
 * 不补就是图上一个洞 —— 站长 2026-09-21 把面板切到后台去跑测速，回来后那一段峰值不在图上。
 */
const RESUME_REFETCH_HIDDEN_MS = 30_000;
/** 兜底：在前台但这么久没收到实时样本（WS 掉了、实时连接到时限），同样重拉一次补上。 */
const STALE_TAIL_REFETCH_MS = 5 * 60_000;

const CPU_KEYS = ["cpu"];
const MEMORY_KEYS = ["ram", "swap"];
const DISK_KEYS = ["disk"];
const DISK_IO_KEYS = ["diskRead", "diskWrite"];
const NETWORK_KEYS = ["netIn", "netOut"];
const CONNECTION_KEYS = ["connections", "udp"];
const LOAD_KEYS = ["load1", "load5", "load15"];
const PROCESS_KEYS = ["process"];
// 线条配色的规矩（站长 2026-10-15 嫌转色相出来的颜色不好看、而且不悬停分不清哪条是哪条）：
// 每张图的主线用那张图自己的颜色，首页卡片上有的指标读同一个 CSS 变量（配色面板改了这里跟着变）；
// 第二条线一律琥珀色、第三条（只有负载）天蓝，整页同一个角色同一个颜色，配合标题下的图例看。
// 网络例外，下行 / 上行沿用首页的两种颜色。按 OKLab 色差量过，浅色 / 深色每对都在 0.2 以上。
const FIXED_CHART_COLORS = {
  light: { second: "#f59e0b", third: "#0ea5e9", diskIo: "#0ea5e9", connections: "#14b8a6", process: "#6366f1" },
  dark: { second: "#fbbf24", third: "#38bdf8", diskIo: "#38bdf8", connections: "#2dd4bf", process: "#818cf8" },
} as const;

function resolveLoadChartColors(appearance: "light" | "dark") {
  const read = (name: string) => safeCanvasColor(`var(${name})`);
  const fixed = FIXED_CHART_COLORS[appearance];
  return {
    cpu: [read("--progress-cpu")],
    // Swap 色的默认值就是琥珀（tokens.css），仍读变量，配色面板里单独改过的照用。
    memory: [read("--progress-memory"), read("--progress-swap")],
    network: [read("--traffic-down"), read("--traffic-up")],
    load: [read("--progress-load"), fixed.second, fixed.third],
    disk: [read("--progress-disk")],
    diskIo: [fixed.diskIo, fixed.second],
    connections: [fixed.connections, fixed.second],
    process: [fixed.process],
  };
}

const SERIES_LABEL_KEYS: Record<string, MessageKey> = {
  ram: "chart.series.ram",
  disk: "metric.disk",
  diskRead: "chart.series.diskRead",
  diskWrite: "chart.series.diskWrite",
  netIn: "traffic.download",
  netOut: "traffic.upload",
  process: "chart.series.process",
  load1: "chart.series.load1",
  load5: "chart.series.load5",
  load15: "chart.series.load15",
};
// 不用翻译的线名（CPU / Swap / TCP / UDP）。
const SERIES_LITERAL_LABELS: Record<string, string> = {
  cpu: "CPU",
  swap: "Swap",
  connections: "TCP",
  udp: "UDP",
};
const LOAD_INTERPOLATE_KEYS = [
  "cpu",
  "ram",
  "swap",
  "disk",
  "diskRead",
  "diskWrite",
  "netIn",
  "netOut",
  "connections",
  "udp",
  "process",
  "load1",
  "load5",
  "load15",
];

interface ChartPoint {
  time: number;
  [key: string]: number | null;
}

function metricData(points: ChartPoint[], keys: string[]): uPlot.AlignedData {
  const times = points.map((point) => point.time);
  return [times, ...keys.map((key) => points.map((point) => point[key] ?? null))] as uPlot.AlignedData;
}

function getHistoryRenderLimit(hours: number) {
  if (hours <= 4) return LOAD_HISTORY_SAMPLE_LIMIT;
  return LOAD_HISTORY_RENDER_LIMIT;
}

const DOWNSAMPLE_KEYS = [
  "cpu",
  "ram",
  "swap",
  "disk",
  "diskRead",
  "diskWrite",
  "netIn",
  "netOut",
  "connections",
  "udp",
  "process",
  "load1",
  "load5",
  "load15",
] as const;

// 走与 Ping 图同一套时间分桶保峰降采样:抽点式降采样会随机丢掉桶内尖峰,
// 而负载/网速的瞬时突刺正是最需要保留的信息。
function downsamplePoints(points: ChartPoint[], limit: number) {
  if (points.length <= limit || limit < 2) return points;

  const times = points.map((point) => point.time);
  const perKey = DOWNSAMPLE_KEYS.map((key) => points.map((point) => point[key]));
  const reduced = downsampleAligned(times, perKey, limit, true);
  return reduced.times.map((time, index) => {
    const point: ChartPoint = { time };
    DOWNSAMPLE_KEYS.forEach((key, keyIndex) => {
      point[key] = reduced.perTask[keyIndex][index] ?? null;
    });
    return point;
  });
}

function getSeriesLabel(key: string) {
  const labelKey = SERIES_LABEL_KEYS[key];
  return labelKey ? t(labelKey) : SERIES_LITERAL_LABELS[key] ?? key;
}

function pointFromNode(node: NodeMetrics): ChartPoint {
  return {
    time: node.updatedAt > 0 ? node.updatedAt / 1000 : Date.now() / 1000,
    cpu: node.cpuPct,
    // total 为 0 表示该指标不存在(如无 Swap),填 null 让 uPlot 不画线,而不是画一条假的 0%。
    ram: node.ramTotal > 0 ? (node.ramUsed / node.ramTotal) * 100 : null,
    swap: node.swapTotal > 0 ? (node.swapUsed / node.swapTotal) * 100 : null,
    disk: node.diskTotal > 0 ? (node.diskUsed / node.diskTotal) * 100 : null,
    diskRead: node.diskIo?.read_bps ?? null,
    diskWrite: node.diskIo?.write_bps ?? null,
    netIn: node.netDown,
    netOut: node.netUp,
    connections: node.connectionsTcp,
    udp: node.connectionsUdp,
    process: node.process,
    load1: node.load1,
    load5: node.load5,
    load15: node.load15,
  };
}

function formatTooltipValue(key: string, value: number | null | undefined, unit: string) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (key === "netIn" || key === "netOut") return formatTrafficRateLabel(value);
  // 磁盘 IO 按字节算(MB/s)，网络按比特算(Mbps)——各自领域的习惯单位。
  if (key === "diskRead" || key === "diskWrite") return formatByteRateLabel(value);
  if (unit === "%") return `${value.toFixed(2)}%`;
  if (key === "process" || key === "connections" || key === "udp") return `${Math.round(value)}`;
  return value.toFixed(2);
}

function formatNetworkAxisValue(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return formatTrafficRateLabel(value);
}

function formatByteRateAxisValue(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return formatByteRateLabel(value);
}

/**
 * 负载图表用样条曲线，和后端内置主题一个观感（站长 2026-09-21 提的）。
 *
 * 样条在尖峰两侧会轻微过冲，非负指标（CPU/网速/连接数）因此可能画到 0 以下 ——
 * uPlot 会把线裁在绘图区里，看着就是贴着底边，不会画出负值刻度。
 */
const SPLINE_PATHS = uPlot.paths.spline?.();

/**
 * 六张负载图共用的纵轴宽度，按刻度文字最宽的那张（网络，如「100.0 Mbps」）定。
 *
 * 原来百分比 / 计数图 52、磁盘 IO 72、网络 78，同一列上下两张图的绘图区左边差 20~26 像素
 * （站长 2026-10-14 要求对齐）。别再按图单独给宽度。
 */
const LOAD_Y_AXIS_SIZE = 78;

type LoadAxisKind = "percent" | "network" | "byteRate" | "count" | "integer";

/** 纵轴范围：下限固定 0，上限取数据最大值留一点余量并取整；全是 0 或没数据时给 0~1。百分比不超过 100。 */
function zeroBasedYRange(max: number | null, axisKind: LoadAxisKind): uPlot.Range.MinMax {
  const top = max != null && Number.isFinite(max) && max > 0 ? max : 1;
  const padded = uPlot.rangeNum(0, top, 0.1, true)[1] ?? top;
  if (axisKind === "percent" && top <= 100) return [0, Math.min(padded, 100)];
  // 整数轴至少到 2，0 以上才放得下 1、2 两档。
  if (axisKind === "integer") return [0, Math.max(padded, 2)];
  return [0, padded];
}

// 不含尺寸的配置。width/height 由调用方在另一个 memo 里加上，resize 时只改这两个 key，
// uplot-react 就会调 setSize() 而不是重建整个 chart。(用普通函数而非 hook——它不调任何
// hook；之前的 `use` 前缀会触发 rules-of-hooks lint。)
function buildBaseOptions({
  title,
  keys,
  colors,
  resolvedAppearance,
  rangeHours,
  spanGaps,
  axisKind,
  getXRange,
  fillAllSeries,
  syncKey,
}: {
  title: string;
  keys: string[];
  colors: string[];
  resolvedAppearance: "light" | "dark";
  rangeHours: number;
  spanGaps?: boolean;
  axisKind: LoadAxisKind;
  /**
   * 历史档钉住的横轴区间，传取值函数而不是区间本身：实时样本每接上一个，区间右端就往后推一次，
   * 区间要是进了 options，uplot-react 比出 options 变了就把整张图销毁重建（每一两秒六张图全部重画）。
   */
  getXRange?: (() => [number, number] | null) | null;
  fillAllSeries?: boolean;
  /** 同一个 key 的几张图游标联动：鼠标在一张图上移动，其余几张在同一时刻显示各自的小窗口。 */
  syncKey: string;
}): Omit<uPlot.Options, "width" | "height"> {
  const isDark = resolvedAppearance === "dark";
  const { grid, text } = getAxisColors(isDark);

  return {
    padding: [8, 12, 10, 2],
    cursor: {
      drag: { x: true, y: false },
      // 六张图按时间联动游标（站长 2026-10-14 要的）。只同步横轴：纵轴各图单位不同，别的图按鼠标的相对高度放游标。
      // 只广播移动（移出图表时 uPlot 也是发一次坐标为负的移动，别的图跟着收起）；拖选缩放不联动，
      // 免得在一张图上拖一下六张一起变。触屏的游标走 setCursor、不广播，手机上图是竖排的，联动没意义。
      sync: {
        key: syncKey,
        scales: ["x", null],
        filters: { pub: (type) => type === "mousemove" },
      },
    },
    legend: { show: false },
    scales: {
      x: getXRange
        ? { time: true, auto: false, range: (_self, min, max) => getXRange() ?? [min, max] }
        : { time: true },
      // 纵轴一律从 0 起（和 Ping 图一样，站长 2026-10-19）：原来按数据上下限自动取，
      // 负载 0.3~0.6、连接数 10~15 这种小波动会被拉满整个图高，看着像大起大落。
      y: {
        auto: true,
        range: (_self, _min, max) => zeroBasedYRange(max, axisKind),
      },
    },
    axes: [
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        size: rangeHours >= 72 ? 38 : 34,
        values: createTimeAxisFormatter(rangeHours),
      },
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        size: LOAD_Y_AXIS_SIZE,
        // 刻度自己算：从 0 起、0 以上至少两档；进程数、连接数只取整数（原来跨度 1 时出「186.5」，站长 2026-10-16 截图）。
        splits: (_self, _axisIdx, _min, max) =>
          zeroBasedTicks(max, {
            integer: axisKind === "integer",
            unit: axisKind === "network" ? "bits" : axisKind === "byteRate" ? "binary" : "decimal",
          }),
        values: (_self, splits) => {
          const decimals = axisDecimals(splits);
          return splits.map((value) => {
            if (value === 0 && axisKind !== "percent") return "";
            if (axisKind === "network") return formatNetworkAxisValue(value);
            if (axisKind === "byteRate") return formatByteRateAxisValue(value);
            if (axisKind === "percent") return `${value.toFixed(decimals)}%`;
            return value.toFixed(decimals);
          });
        },
      },
    ],
    series: [
      { label: "time" },
      ...keys.map((key, index) => ({
        label: key,
        stroke: colors[index] ?? colors[0],
        // 默认只给第一条线填充；两条线地位对等时(磁盘读/写)全填，否则恰好为 0 的那条
        // 会独占填充色，看起来像它才是主角。
        fill: fillAllSeries || index === 0 ? chartAlpha(colors[index] ?? colors[0], 0.13) : undefined,
        width: 1.6,
        paths: SPLINE_PATHS,
        spanGaps: spanGaps ?? false,
        points: SPARSE_SERIES_POINTS,
      })),
    ],
    hooks: {
      init: [
        (u) => {
          u.root.setAttribute("role", "img");
          u.root.setAttribute("aria-label", title);
        },
      ],
    },
  };
}

const ChartCard = memo(function ChartCard({
  icon,
  title,
  value,
  note,
  uuid,
  points,
  keys,
  colors,
  resolvedAppearance,
  rangeHours,
  unit = "",
  spanGaps,
  axisKind,
  xRange,
  fillAllSeries,
  accent,
}: {
  icon: ReactNode;
  title: string;
  value: ReactNode;
  note?: ReactNode;
  uuid: string;
  points: ChartPoint[];
  keys: string[];
  colors: string[];
  resolvedAppearance: "light" | "dark";
  rangeHours: number;
  unit?: string;
  spanGaps?: boolean;
  axisKind: LoadAxisKind;
  xRange?: [number, number] | null;
  fillAllSeries?: boolean;
  /** 卡片边框/图标的主色。默认跟随第一条线，指标本身有固定色时用它覆盖。 */
  accent?: string;
}) {
  const { w, h, ref: chartSizeRef } = useResponsiveChartSize("grid");
  const dataRef = useRef<uPlot.AlignedData>([[]]);
  const [tooltip, setTooltip] = useState<ChartTooltipState>({
    show: false,
    left: 0,
    top: 0,
    rows: [],
    time: "",
  });
  const data = useMemo(() => metricData(points, keys), [points, keys]);
  useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);
  // 区间放 ref 里，options 只跟「有没有钉区间」走；uplot-react 的 setData 在子组件的 effect 里，
  // 晚于这里的 layout effect，重算横轴时读到的已经是新区间。
  const xRangeRef = useRef(xRange ?? null);
  useLayoutEffect(() => {
    xRangeRef.current = xRange ?? null;
  }, [xRange]);
  const hasXRange = xRange != null;
  const readXRange = useCallback(() => xRangeRef.current, []);
  const baseOptions = useMemo(
    () =>
      buildBaseOptions({
        title,
        keys,
        colors,
        resolvedAppearance,
        rangeHours,
        spanGaps,
        axisKind,
        getXRange: hasXRange ? readXRange : null,
        fillAllSeries,
        syncKey: `load-charts:${uuid}`,
      }),
    [
      axisKind,
      colors,
      fillAllSeries,
      hasXRange,
      keys,
      rangeHours,
      readXRange,
      resolvedAppearance,
      spanGaps,
      title,
      uuid,
    ],
  );

  const enhancedOptions = useMemo<Omit<uPlot.Options, "width" | "height">>(() => {
    const tooltip = buildChartTooltipHooks({
      dataRef,
      rangeHours,
      estimatedWidth: 176,
      setTooltip,
      buildRows: (idx) =>
        keys.map((key, keyIndex) => ({
          label: getSeriesLabel(key),
          value: formatTooltipValue(
            key,
            dataRef.current[keyIndex + 1]?.[idx] as number | null | undefined,
            unit,
          ),
          color: colors[keyIndex] ?? colors[0],
        })),
    });
    return {
      ...baseOptions,
      hooks: {
        ...baseOptions.hooks,
        init: [...(baseOptions.hooks?.init ?? []), tooltip.onInit],
        destroy: [...(baseOptions.hooks?.destroy ?? []), tooltip.onDestroy],
        setCursor: [tooltip.onSetCursor],
      },
    };
  }, [colors, keys, baseOptions, rangeHours, unit]);

  const chartOptions = useMemo<uPlot.Options>(
    () => ({ ...enhancedOptions, width: w, height: h }) as uPlot.Options,
    [enhancedOptions, w, h],
  );

  return (
    <div
      className="instance-chart-card"
      style={{ "--chart-accent": accent ?? colors[0] } as CSSProperties}
    >
      <header className="instance-chart-card-head">
        <div className="instance-chart-card-title">
          <div className="instance-panel-subhead">
            {icon}
            <span>{title}</span>
          </div>
          {/* 多条线的图常驻图例，不悬停也知道哪条是哪条（站长 2026-10-15）。 */}
          {keys.length > 1 && (
            <ul className="instance-chart-legend">
              {keys.map((key, index) => (
                <li key={key}>
                  <span
                    className="instance-chart-legend-swatch"
                    style={{ background: colors[index] ?? colors[0] }}
                    aria-hidden
                  />
                  {getSeriesLabel(key)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="instance-series-stats">
          <span className="tabular">{value}</span>
          {note != null && <span className="tabular text-[var(--text-tertiary)]">{note}</span>}
        </div>
      </header>
      <div ref={chartSizeRef} className="instance-uplot-wrap">
        {/* 每档都要重算坐标轴：历史档的横轴右端跟着实时样本走、纵轴要装得下新样本。
            历史档横轴本来就钉在区间上（拖选缩放不生效），重算不会丢掉什么。 */}
        <UplotReact key={`${uuid}-${rangeHours}`} options={chartOptions} data={data} />
        <ChartTooltip tooltip={tooltip} />
      </div>
    </div>
  );
});

export function LoadChart({
  uuid,
  hours,
  active = true,
}: {
  uuid: string;
  hours: number;
  active?: boolean;
}) {
  const queryHours = hours === 0 ? REALTIME_QUERY_HOURS : hours;
  const { data, isError, isFetching, isLoading, refetch } = useLoadRecords(
    uuid,
    queryHours,
    active,
  );
  const isRealtime = hours === 0;
  // 历史档也要实时值：历史只有打开时那一份，不接实时样本的话，页面开着的这段时间里
  // 发生的事（比如跑一次测速）在图上根本不会出现（站长 2026-09-21 反馈，内置主题是接着画的）。
  const node = useNodeMetrics(uuid, active);
  const meta = useNodeMeta(uuid);
  const { resolvedAppearance } = usePreferences();
  const metricColorsVersion = useMetricColorsVersion();
  const chartColors = useMemo(
    () => resolveLoadChartColors(resolvedAppearance),
    // 配色面板改色时版本号变，要重新读 CSS 变量（函数里没用到它，lint 看不出这层依赖）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedAppearance, metricColorsVersion],
  );
  const [realtimePoints, setRealtimePoints] = useState<ChartPoint[]>([]);
  /** 上一条实时样本的到达时刻，用来发现「断了一段」。 */
  const lastSampleAtRef = useRef(0);
  const [connectNulls, setConnectNulls] = useState(false);
  const totalFallbacks = useMemo(
    () => ({
      ramTotal: meta?.mem_total,
      swapTotal: meta?.swap_total,
      diskTotal: meta?.disk_total,
    }),
    [meta?.disk_total, meta?.mem_total, meta?.swap_total],
  );

  useEffect(() => {
    // 掉线的节点不再接实时点：快照里那份是最后一次上报，时钟快的节点它还落在将来，
    // 会让「实时」档只剩一个将来的点（站长 2026-10-26：PQS-tw 关机后详情页显示「覆盖 17:33 - 17:33」）。
    if (!active || !node || node.online === false) return;
    const now = Date.now();
    const sinceLast = lastSampleAtRef.current > 0 ? now - lastSampleAtRef.current : 0;
    lastSampleAtRef.current = now;
    // 断了很久才又收到样本：中间那段只有后端的历史里有，重拉一次把洞补上。
    if (sinceLast >= STALE_TAIL_REFETCH_MS) void refetch();
    const point = pointFromNode(node);
    // 实时档只看最近一段，超上限砍最老的；历史档要一直接到历史末尾，超上限改为抽稀（见 appendLiveChartPoint）。
    setRealtimePoints((prev) =>
      appendLiveChartPoint(prev, point, {
        dense: isRealtime,
        limit: isRealtime ? REALTIME_SAMPLE_LIMIT : undefined,
      }),
    );
  }, [active, isRealtime, node, refetch]);

  // 回到前台补历史：后台那段时间实时推送是断的，只靠实时样本接不回来。
  useEffect(() => {
    if (!active) return;
    let hiddenSince = document.hidden ? Date.now() : 0;
    const onVisibilityChange = () => {
      if (document.hidden) {
        hiddenSince = Date.now();
        return;
      }
      const awayMs = hiddenSince > 0 ? Date.now() - hiddenSince : 0;
      hiddenSince = 0;
      if (awayMs >= RESUME_REFETCH_HIDDEN_MS) void refetch();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [active, refetch]);

  useEffect(() => {
    setRealtimePoints([]);
    lastSampleAtRef.current = 0;
  }, [hours, uuid]);

  const historyRecords = useMemo<Array<{ record: LoadRecord; time: number }>>(
    () =>
      (data?.records ?? [])
        .map((record) => ({ record, time: toChartSeconds(record.time) }))
        .filter(({ time }) => time > 0)
        .sort((left, right) => left.time - right.time),
    [data],
  );

  const historyPoints = useMemo<ChartPoint[]>(() => {
    const rawPoints = historyRecords.map(({ record, time }) => {
      const totals = resolveLoadRecordTotals(record, totalFallbacks);
      return {
        time,
        cpu: record.cpu,
        ram: totals.ramTotal > 0 ? (record.ram / totals.ramTotal) * 100 : null,
        swap: totals.swapTotal > 0 ? (record.swap / totals.swapTotal) * 100 : null,
        disk: totals.diskTotal > 0 ? (record.disk / totals.diskTotal) * 100 : null,
        diskRead: record.disk_read,
        diskWrite: record.disk_write,
        netIn: record.net_in,
        netOut: record.net_out,
        connections: record.connections,
        udp: record.connections_udp,
        process: record.process,
        load1: record.load,
        load5: record.load5,
        load15: record.load15,
      };
    });
    const sampled = downsamplePoints(rawPoints, getHistoryRenderLimit(hours));
    const filled = fillMissingMetricPoints(sampled);
    return interpolateMetricGaps(filled, LOAD_INTERPOLATE_KEYS) as ChartPoint[];
  }, [historyRecords, hours, totalFallbacks]);

  const points = useMemo<ChartPoint[]>(() => {
    if (isRealtime) {
      const seed = historyPoints.slice(-REALTIME_HISTORY_SEED_LIMIT);
      const seeded = mergeHistoryWithLivePoints(
        seed,
        resampleLiveTail(seed, realtimePoints, LOAD_INTERPOLATE_KEYS, REALTIME_LIVE_STEP_SECONDS),
      );
      const newest = seeded[seeded.length - 1]?.time;
      const windowed =
        newest == null
          ? seeded
          : seeded.filter((point) => point.time >= newest - REALTIME_WINDOW_SECONDS);
      return windowed.slice(-REALTIME_SAMPLE_LIMIT);
    }
    // 历史档：历史那段以历史为准，实时样本只接在它后面，并按历史的点距并格（不然挤成一团）。
    return mergeHistoryWithLivePoints(
      historyPoints,
      resampleLiveTail(historyPoints, realtimePoints, LOAD_INTERPOLATE_KEYS),
    );
  }, [historyPoints, isRealtime, realtimePoints]);

  // API 各回退路径不保证返回顺序,最新值必须取自按时间排好序的 historyRecords。
  const latestHistoryRecord = historyRecords[historyRecords.length - 1]?.record;
  const latestHistoryTotals = latestHistoryRecord
    ? resolveLoadRecordTotals(latestHistoryRecord, totalFallbacks)
    : null;
  // 磁盘 IO：有实时值就用实时值，否则看这段区间里有没有采到过。旧探针/旧后端不下发时
  // 整段都是 null，此时磁盘卡片退回原来的已用空间图。
  const latestDiskIo = useMemo(() => {
    if (node?.diskIo) {
      return { read: node.diskIo.read_bps, write: node.diskIo.write_bps };
    }
    if (latestHistoryRecord?.disk_read != null || latestHistoryRecord?.disk_write != null) {
      return {
        read: latestHistoryRecord.disk_read ?? 0,
        write: latestHistoryRecord.disk_write ?? 0,
      };
    }
    return null;
  }, [latestHistoryRecord, node?.diskIo]);
  const hasDiskIo = useMemo(
    () => points.some((point) => point.diskRead != null || point.diskWrite != null),
    [points],
  );
  const diskUsageLabel =
    node
      ? `${formatBytes(node.diskUsed)} / ${formatBytes(node.diskTotal)}`
      : latestHistoryRecord && latestHistoryTotals
        ? `${formatBytes(latestHistoryRecord.disk)} / ${formatBytes(latestHistoryTotals.diskTotal)}`
        : "—";
  const sourceRecordCount = historyRecords.length;
  const wasDownsampled = !isRealtime && sourceRecordCount > getHistoryRenderLimit(hours);
  const sampleSummary = isRealtime
    ? t("chart.points", { n: points.length })
    : wasDownsampled
      ? t("chart.pointsOf", { n: points.length, total: sourceRecordCount })
      : t("chart.points", { n: points.length });
  const coverageSummary = points.length
    ? `${formatChartCoverageTime(points[0].time)} - ${formatChartCoverageTime(points[points.length - 1].time)}`
    : "—";
  const lastPointTime = points[points.length - 1]?.time;
  const requestedXRange = useMemo(() => {
    if (isRealtime) return null;
    const range = historyChartRangeSeconds(data);
    // 后端给的区间截止到取数那一刻；实时样本接上来之后要把右端跟着推，否则新的点画在坐标轴外面。
    if (!range) return null;
    return lastPointTime != null && lastPointTime > range[1]
      ? ([range[0], lastPointTime] as [number, number])
      : range;
  }, [data, isRealtime, lastPointTime]);
  const coverageLabel = useMemo(
    () =>
      isRealtime
        ? null
        : historyCoverageLabel(data, points[0]?.time, points[points.length - 1]?.time),
    [data, isRealtime, points],
  );

  if (isLoading) {
    return <InstanceChartLoading title={t("chart.loadTitle")} />;
  }

  if (isError && !points.length) {
    return (
      <InstancePanel title={t("chart.loadTitle")}>
        <div className="instance-empty">
          <span>{t("chart.loadFailed")}</span>
          <button
            type="button"
            className="instance-toggle-button"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-busy={isFetching}
          >
            {isFetching ? t("common.retrying") : t("common.retry")}
          </button>
        </div>
      </InstancePanel>
    );
  }

  if (!points.length) {
    return (
      <InstancePanel title={t("chart.loadTitle")}>
        <div className="instance-empty">
          <span>{t("chart.loadEmpty")}</span>
          <button
            type="button"
            className="instance-toggle-button"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-busy={isFetching}
          >
            <RefreshCw size={14} aria-hidden />
            {isFetching ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
      </InstancePanel>
    );
  }

  return (
    <InstancePanel
      title={t("chart.loadTitle")}
      aside={
        <div className="instance-chart-headmeta">
          <div className="instance-chart-meta" aria-label={t("chart.rangeLabel")}>
            <span title={coverageSummary}>
              <strong>{coverageLabel ?? t("chart.coverage", { range: coverageSummary })}</strong>
            </span>
            <span>
              {t("chart.samples")} <strong>{sampleSummary}</strong>
            </span>
          </div>
          <SwitchToggle
            label={t("chart.connectGaps")}
            active={connectNulls}
            onToggle={() => setConnectNulls((value) => !value)}
          />
          <button
            type="button"
            className="instance-toggle-button"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-busy={isFetching}
          >
            <RefreshCw size={14} aria-hidden />
            {isFetching ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
      }
      className="instance-chart-panel"
    >
      <div className="instance-chart-grid">
        <ChartCard
          icon={<Cpu size={13} />}
          title="CPU"
          uuid={uuid}
          value={
            node
              ? `${node.cpuPct.toFixed(2)}%`
              : `${(points[points.length - 1]?.cpu ?? 0).toFixed(2)}%`
          }
          note={t("chart.cpuNote")}
          points={points}
          keys={CPU_KEYS}
          colors={chartColors.cpu}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
          xRange={requestedXRange}
        />
        <ChartCard
          icon={<MemoryStick size={13} />}
          title={t("metric.memory")}
          uuid={uuid}
          value={
            node
              ? `${formatBytes(node.ramUsed)} / ${formatBytes(node.ramTotal)}`
              : latestHistoryRecord && latestHistoryTotals
                ? `${formatBytes(latestHistoryRecord.ram)} / ${formatBytes(latestHistoryTotals.ramTotal)}`
                : "—"
          }
          note={
            node
              ? node.swapTotal
                ? `Swap ${formatBytes(node.swapUsed)} / ${formatBytes(node.swapTotal)}`
                : t("chart.swapNone")
              : latestHistoryRecord && latestHistoryTotals && latestHistoryTotals.swapTotal > 0
                ? `Swap ${formatBytes(latestHistoryRecord.swap)} / ${formatBytes(latestHistoryTotals.swapTotal)}`
                : t("chart.swapNone")
          }
          points={points}
          keys={MEMORY_KEYS}
          colors={chartColors.memory}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
          xRange={requestedXRange}
        />
        <ChartCard
          icon={<Network size={13} />}
          title={t("chart.network")}
          uuid={uuid}
          value={
            node
              ? `${formatTrafficRateLabel(node.netDown)} / ${formatTrafficRateLabel(node.netUp)}`
              : latestHistoryRecord
                ? `${formatTrafficRateLabel(latestHistoryRecord.net_in ?? 0)} / ${formatTrafficRateLabel(latestHistoryRecord.net_out ?? 0)}`
                : "—"
          }
          note={
            <span className="instance-overview-multi">
              <span className="inline-flex items-center gap-1"><ArrowDown size={11} />{node ? formatBytes(node.trafficDown) : latestHistoryRecord ? formatBytes(latestHistoryRecord.net_total_down ?? 0) : "—"}</span>
              <span className="inline-flex items-center gap-1"><ArrowUp size={11} />{node ? formatBytes(node.trafficUp) : latestHistoryRecord ? formatBytes(latestHistoryRecord.net_total_up ?? 0) : "—"}</span>
            </span>
          }
          points={points}
          keys={NETWORK_KEYS}
          colors={chartColors.network}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="network"
          xRange={requestedXRange}
        />
        <ChartCard
          icon={<Gauge size={13} />}
          title={t("metric.load")}
          uuid={uuid}
          value={
            node
              ? `${node.load1.toFixed(2)} / ${node.load5.toFixed(2)} / ${node.load15.toFixed(2)}`
              : latestHistoryRecord
                ? `${latestHistoryRecord.load.toFixed(2)} / ${latestHistoryRecord.load5.toFixed(2)} / ${latestHistoryRecord.load15.toFixed(2)}`
                : "—"
          }
          // 核心数是看负载高不高的参照（负载持续超过核心数 = 有进程在排队）。
          note={meta?.cpu_cores ? t("metric.cpuCores", { n: meta.cpu_cores }) : undefined}
          points={points}
          keys={LOAD_KEYS}
          colors={chartColors.load}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="count"
          xRange={requestedXRange}
        />
        <ChartCard
          icon={<HardDrive size={13} />}
          title={t("metric.disk")}
          uuid={uuid}
          value={diskUsageLabel}
          note={t("chart.diskUsedSpace")}
          points={points}
          keys={DISK_KEYS}
          colors={chartColors.disk}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
          xRange={requestedXRange}
        />
        {/* 探针没上报 IO 时不画这张（会是一张空图），只剩上面的空间占用。 */}
        {hasDiskIo && (
          <ChartCard
            icon={<HardDrive size={13} />}
            title={t("chart.diskIo")}
            uuid={uuid}
            value={
              latestDiskIo
                ? t("chart.diskIoValue", {
                    read: formatByteRateLabel(latestDiskIo.read),
                    write: formatByteRateLabel(latestDiskIo.write),
                  })
                : "—"
            }
            points={points}
            keys={DISK_IO_KEYS}
            colors={chartColors.diskIo}
            resolvedAppearance={resolvedAppearance}
            rangeHours={hours}
            spanGaps={connectNulls}
            axisKind="byteRate"
            xRange={requestedXRange}
            fillAllSeries
          />
        )}
        <ChartCard
          icon={<Workflow size={13} />}
          title={t("chart.connections")}
          uuid={uuid}
          value={
            node
              ? `TCP ${node.connectionsTcp} / UDP ${node.connectionsUdp}`
              : latestHistoryRecord
                ? `TCP ${Math.round(latestHistoryRecord.connections ?? 0)} / UDP ${Math.round(latestHistoryRecord.connections_udp ?? 0)}`
                : "—"
          }
          points={points}
          keys={CONNECTION_KEYS}
          colors={chartColors.connections}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="integer"
          xRange={requestedXRange}
        />
        <ChartCard
          icon={<Layers size={13} />}
          title={t("chart.processes")}
          uuid={uuid}
          value={
            node
              ? node.process.toString()
              : latestHistoryRecord
                ? Math.round(latestHistoryRecord.process ?? 0).toString()
                : "—"
          }
          note={t("chart.processesNote")}
          points={points}
          keys={PROCESS_KEYS}
          colors={chartColors.process}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="integer"
          xRange={requestedXRange}
        />
      </div>
    </InstancePanel>
  );
}
