import { HOMEPAGE_MULTI_PING_MAX_COUNT } from "@/utils/pingTasks";

/**
 * 访客在多线路卡片上点线路名换过的线路，一台节点一份：`{ 行号: 线路 id }`。行号从 0 起，
 * 对应站点设置 `homepageMultiPingTaskIds` 的下标。
 *
 * 只记「和站点设置不一样的行」，不整份拷贝 —— 站长以后在设置页调线路，访客没动过的行照样跟着走。
 */
export type PingLineOverrides = Readonly<Record<string, number>>;

/** 没换过时的共享空表：引用稳定，store 快照和 memo 依赖可以直接拿它比较。 */
export const EMPTY_PING_LINE_OVERRIDES: PingLineOverrides = Object.freeze({});

const SLOT_KEY_PATTERN = /^(0|[1-9]\d*)$/;

function isPositiveTaskId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * 存储里读出来的东西不可信：行号只认规范写法（不认 `01`）、且不超过多线路条数上限；线路 id 只认
 * 正整数，再由 `isKnownTaskId` 按线路表筛一遍（util 层不依赖 services，线路表由调用方带进来）。
 */
export function normalizePingLineOverrides(
  value: unknown,
  isKnownTaskId: (taskId: number) => boolean = () => true,
): PingLineOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_PING_LINE_OVERRIDES;
  }
  const normalized: Record<string, number> = {};
  for (const [slot, taskId] of Object.entries(value)) {
    if (!SLOT_KEY_PATTERN.test(slot) || Number(slot) >= HOMEPAGE_MULTI_PING_MAX_COUNT) {
      continue;
    }
    if (!isPositiveTaskId(taskId) || !isKnownTaskId(taskId)) continue;
    normalized[slot] = taskId;
  }
  return Object.keys(normalized).length > 0 ? normalized : EMPTY_PING_LINE_OVERRIDES;
}

/**
 * 这台节点实际显示哪几条线路：站点设置打底，本机换过的行盖上去。条数永远跟站点设置走。
 *
 * 盖完出现重复（站长后来改了设置，恰好把访客换上的那条排进了别的行）时整份退回站点设置 ——
 * 同一条线路画两行没有意义，逐行猜「该让哪行让位」只会让访客更摸不着头脑。
 * 没有生效的覆盖时原样返回 `siteTaskIds`，引用不变，可以直接进依赖数组。
 */
export function resolveNodePingLineTaskIds(
  siteTaskIds: readonly number[],
  overrides: PingLineOverrides = EMPTY_PING_LINE_OVERRIDES,
): readonly number[] {
  let changed = false;
  const resolved = siteTaskIds.map((taskId, slot) => {
    const override = overrides[String(slot)];
    if (override == null || override === taskId) return taskId;
    changed = true;
    return override;
  });
  if (!changed) return siteTaskIds;
  return new Set(resolved).size === resolved.length ? resolved : siteTaskIds;
}

/**
 * 把第 `slot` 行换成 `taskId`，返回新的覆盖表。
 *
 * 选中的线路已经在别的行显示时两行互换，不会画出两行一样的线路。换回和站点设置一致的行会从表里
 * 删掉，所以全部换回去之后得到的就是空表（等于恢复默认）；过期的行（超出现在的条数）顺手丢掉。
 */
export function switchPingLine(
  siteTaskIds: readonly number[],
  overrides: PingLineOverrides,
  slot: number,
  taskId: number,
): PingLineOverrides {
  const displayed = [...resolveNodePingLineTaskIds(siteTaskIds, overrides)];
  if (
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= displayed.length ||
    !isPositiveTaskId(taskId) ||
    displayed[slot] === taskId
  ) {
    return overrides;
  }
  const shownAt = displayed.indexOf(taskId);
  if (shownAt >= 0) displayed[shownAt] = displayed[slot]!;
  displayed[slot] = taskId;

  const next: Record<string, number> = {};
  displayed.forEach((id, index) => {
    if (id !== siteTaskIds[index]) next[String(index)] = id;
  });
  return Object.keys(next).length > 0 ? next : EMPTY_PING_LINE_OVERRIDES;
}
