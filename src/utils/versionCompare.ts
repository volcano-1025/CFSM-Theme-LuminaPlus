/**
 * 版本号比较。认 `1.2.15`、`v1.2.15`、`2.8.5 Beta5`、`2.8.5-beta.5`、`2.8.5 RC1` 这几种写法：
 * 数字段逐段比；同号时预发布低于正式版（2.8.5 Beta5 < 2.8.5），同为预发布按 alpha < beta < rc、再比序号。
 *
 * 认不出的返回 null，版本提醒据此**不提示** —— 后端的 `last_workers_version` 是远端 version.json 原样给的，
 * 写法哪天变了宁可漏报，也不能让站长天天看见一个假的「有新版」。
 */

const VERSION_PATTERN = /^v?(\d+(?:\.\d+)*)(?:[\s._-]*(alpha|beta|rc)[\s._-]*(\d+)?)?$/i;
const CHANNEL_RANK: Record<string, number> = { alpha: 0, beta: 1, rc: 2 };
const RELEASE_RANK = 3;

interface ParsedVersion {
  parts: number[];
  channel: number;
  serial: number;
}

function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(VERSION_PATTERN);
  if (!match) return null;
  return {
    parts: match[1]!.split(".").map(Number),
    channel: match[2] ? CHANNEL_RANK[match[2].toLowerCase()]! : RELEASE_RANK,
    serial: match[3] ? Number(match[3]) : 0,
  };
}

/** a 比 b 新返回正数、旧返回负数、相同返回 0；任一认不出返回 null。 */
export function compareVersions(a: unknown, b: unknown): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.channel !== right.channel) return left.channel - right.channel;
  return left.serial - right.serial;
}

/** `candidate` 确实比 `current` 新才返回 true；认不出一律 false。 */
export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  const result = compareVersions(candidate, current);
  return result != null && result > 0;
}

/** 页脚展示用：`2.8.5 Beta5` → `v2.8.5 Beta5`，已经带 v 的不重复加。 */
export function formatVersionLabel(raw: string): string {
  const trimmed = raw.trim();
  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
}
