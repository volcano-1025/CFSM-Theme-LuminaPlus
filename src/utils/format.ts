const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const CLOCK_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const TRAFFIC_RATE_THRESHOLDS: Array<{ unit: Exclude<TrafficRateUnit, "bps">; divisor: number }> = [
  { unit: "Tbps", divisor: 1_000_000_000_000 },
  { unit: "Gbps", divisor: 1_000_000_000 },
  { unit: "Mbps", divisor: 1_000_000 },
  { unit: "Kbps", divisor: 1_000 },
];
export const LONG_TERM_EXPIRE_DAYS = 36500;

type ExpireTone = "ok" | "warn" | "critical" | "long" | "none";
type TrafficRateUnit = "bps" | "Kbps" | "Mbps" | "Gbps" | "Tbps";

interface TrafficRateDisplay {
  value: string;
  unit: TrafficRateUnit;
}

export function trimFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "0";
  return value
    .toFixed(digits)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?[1-9])0+$/, "$1");
}

export function joinDisplayParts(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export function formatBytes(n: number | undefined | null): string {
  if (!n || n < 0 || !Number.isFinite(n)) return "0 B";
  let idx = 0;
  let v = n;
  while (v >= 1024 && idx < UNITS.length - 1) {
    v /= 1024;
    idx += 1;
  }
  if (idx === 0) return `${Math.round(v)} ${UNITS[idx]}`;
  const dec = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(dec)} ${UNITS[idx]}`;
}

/** 只显示时分（本地时区），用于峰值时间、更新时间等场景。 */
export function formatClockTime(timeMs: number | null | undefined): string {
  if (timeMs == null || !Number.isFinite(timeMs)) return "—";
  return CLOCK_TIME_FORMATTER.format(timeMs);
}

function formatRateValue(value: number): string {
  if (value >= 100) return Math.round(value).toString();
  if (value >= 10) return trimFixed(value, 1);
  // 只会以 bitsPerSec / divisor 的形式调用,且 bitsPerSec >= divisor,所以 value 恒 >= 1,
  // 不存在小于 1 的分支。
  return trimFixed(value, 2);
}

function formatTrafficRate(bytesPerSec: number | undefined | null): TrafficRateDisplay {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return {
      value: "0",
      unit: "bps",
    };
  }

  const bitsPerSec = bytesPerSec * 8;
  for (const { unit, divisor } of TRAFFIC_RATE_THRESHOLDS) {
    if (bitsPerSec >= divisor) {
      return {
        value: formatRateValue(bitsPerSec / divisor),
        unit,
      };
    }
  }

  return {
    value: bitsPerSec >= 100 ? Math.round(bitsPerSec).toString() : trimFixed(bitsPerSec, 1),
    unit: "bps",
  };
}

export function formatTrafficRateLabel(bytesPerSec: number | undefined | null): string {
  const rate = formatTrafficRate(bytesPerSec);
  return `${rate.value} ${rate.unit}`;
}

export interface ByteRateDisplay {
  value: string;
  unit: string;
}

// 按字节算的速率(KB/s · MB/s · GB/s · TB/s)——和 formatBytes 同一套 1024 进制,只是加了 "/s" 后缀。
// 用在传输速度按字节比按比特更自然的地方(如首页实时带宽和节点卡速度),而不是 bps/Kbps/Mbps。
export function formatByteRate(bytesPerSec: number | undefined | null): ByteRateDisplay {
  const [value, unit = "B"] = formatBytes(bytesPerSec).split(" ");
  return { value, unit: `${unit}/s` };
}

export function formatByteRateLabel(bytesPerSec: number | undefined | null): string {
  const { value, unit } = formatByteRate(bytesPerSec);
  return `${value} ${unit}`;
}

export function formatUptimeDays(seconds: number): { value: string; unit: string } {
  if (!Number.isFinite(seconds) || seconds <= 0) return { value: "—", unit: "" };
  const days = seconds / 86400;
  if (days >= 1) return { value: Math.floor(days).toString(), unit: "天" };
  const hours = seconds / 3600;
  if (hours >= 1) return { value: Math.floor(hours).toString(), unit: "小时" };
  // 不足 1 分钟向上取整,避免刚上线显示成「0 分钟」而 <=0 又显示「—」的口径分裂。
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return { value: minutes.toString(), unit: "分钟" };
}

// 将 `expired_at` 解析为毫秒；空值、Go 零时和 0/-1 哨兵均表示无到期。
export function resolveExpireTimestamp(
  iso: string | number | null | undefined,
): number | null {
  if (iso == null) return null;
  const raw = String(iso).trim();
  if (raw === "") return null;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (n <= 0) return null; // 0 / -1 "无到期" 哨兵值
    return n < 1e12 ? n * 1000 : n; // unix 秒 vs. 毫秒
  }
  const ts = Date.parse(raw);
  if (Number.isNaN(ts) || ts <= 0) return null; // 无法解析或 Go 零时
  return ts;
}

export function getExpireDaysRemaining(
  iso: string | number | null | undefined,
  now = Date.now(),
): number | null {
  const ts = resolveExpireTimestamp(iso);
  if (ts == null || !Number.isFinite(now)) return null;
  return Math.floor((ts - now) / 86400000);
}

function resolveExpireTone(days: number | null | undefined): ExpireTone {
  if (days == null || !Number.isFinite(days)) return "none";
  if (days > LONG_TERM_EXPIRE_DAYS) return "long";
  if (days > 30) return "ok";
  if (days > 7) return "warn";
  return "critical";
}

export function formatExpireDays(
  iso: string | null | undefined,
  now = Date.now(),
): { value: string; unit: string; tone: ExpireTone } {
  const days = getExpireDaysRemaining(iso, now);
  const tone = resolveExpireTone(days);
  if (days == null) return { value: "—", unit: "", tone };
  if (tone === "long") return { value: "长期", unit: "", tone };
  if (days > 0) return { value: days.toString(), unit: "天", tone };
  if (days === 0) return { value: "今日", unit: "", tone };
  return { value: "已过期", unit: "", tone };
}

function inferPlainTagColor(label: string): string {
  const normalized = label.trim().toLowerCase();

  if (/(cn2gia|9929|cmin2)/i.test(normalized)) {
    return "blue";
  }

  if (/(163pp|163|4837|cmi)/i.test(normalized)) {
    return "green";
  }

  return "violet";
}

/** 把 `tag1<color>;tag2<color2>` 解析成 [{ label, color }]。 */
/**
 * 分隔符同时认逗号和分号。
 *
 * CF-Server-Monitor 后台那个「标签」输入框的提示写的是**英文逗号割开**，而这份代码从 Komari
 * 主题移植过来时只切分号 —— 于是后台按提示填的 `边缘,高带宽` 会整条变成一个标签。
 * 两种都认：分号是 Komari 的习惯（从那边迁过来的站点还留着），逗号是本后端的正式约定。
 * 全角 `，；` 一并认 —— 这个框的语义就是「用符号分隔」，中文输入法误打全角在所难免，
 * 而标签名里本来也不该出现分隔符。
 */
const TAG_SEPARATORS = /[;,；，]/;

export function parseTags(raw: string | undefined | null): Array<{ label: string; color: string }> {
  if (!raw) return [];
  return raw
    .split(TAG_SEPARATORS)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = item.match(/^(.*?)<([a-zA-Z]+)>$/);
      if (m) return { label: m[1].trim(), color: m[2].toLowerCase() };
      return { label: item, color: inferPlainTagColor(item) };
    });
}
