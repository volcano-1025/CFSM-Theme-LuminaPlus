import type { PingOverviewBucket } from "@/types/cfsm";

/**
 * 首页延迟数据的自检：判断 `/api/servers` 给的 `ping[]` / `loss[]` 这一份到底能不能看。
 *
 * 后端窗口是低保真的填充产物（`buildFixedLatencySeries` 用无上限最近邻把 30 格补满，
 * 详见 CLAUDE.md），主题这边 `dropBackfilledRuns` 会把连续复印的那几段整段丢掉 ——
 * 于是**用户看到的「某个时段是同一个值」，落到这一版上就是柱子大片空缺**。所以判据只有一条：
 *
 * - **柱子空缺**：卡片实际画出来的格子里，有多大比例是没值的（掉线格不算，那是真的没数据）。
 *
 * 「后端这一份窗口里有多少格是复印件」只作为**理由**记下来（弹窗里要说清楚为什么空），
 * 不单独构成判据：窗口再假，只要本地实测已经把这一小时铺满，卡片上就是真数据，
 * 这时候再让用户花一次 D1 读行毫无意义。
 *
 * **丢包全是 0 不是证据**：探测正常时丢包本来就该是 0。复印段的判定（`samePing`）要求四条线路的
 * 延迟**和**丢包同时逐字节相同，光丢包为 0 而延迟在变的窗口不会被算进去，这里也不另外看丢包。
 *
 * 判定完只是「值不值得弹一次窗问用户」——真要补数据得逐台查 `/api/history/all`，那是要花
 * D1 读行的，所以宁可漏判也别乱打断（见 {@link shouldPromptPingRefresh}）。
 */

/** 自检按默认的 30 格窗口来算，和大卡一致；各视图的格数不同，不跟着变以免阈值飘。 */
export const HEALTH_BUCKET_COUNT = 30;
/** 非掉线格里有这么大比例没值，就算「柱子明显空缺」。30 格里空 9 格。 */
export const GAP_RATIO_THRESHOLD = 0.3;
/** 后端窗口里这么大比例的格子是复印段，就把「后端在编数据」记进理由里。 */
export const BACKFILL_RATIO_THRESHOLD = 0.4;
/** 可判定的格子少于这些就不判：整段掉线、或者刚被加进来的节点，空是应该的。 */
export const MIN_ASSESSABLE_BUCKETS = 8;
/** 掉线超过这么久的节点不参与判定：它的窗口本来就该是空的，刷新也拿不回来。 */
export const MAX_OFFLINE_MS = 30 * 60 * 1000;
/**
 * 面板里有这么大比例的节点可疑才值得弹窗。
 *
 * 刷新是**所有节点**各来一次历史查询，为一台落单的节点让全场付这个钱不划算 ——
 * 那种情况留给右上角的手动刷新按钮。
 */
export const SUSPECT_RATIO_THRESHOLD = 0.25;
/** 探针上报间隔缺失时的兜底，用于估算刷新要读多少行。 */
const DEFAULT_REPORT_INTERVAL_SECONDS = 60;

export type PingHealthReason = "gap" | "backfilled";

export interface NodePingHealthInput {
  uuid: string;
  /**
   * 卡片实际画出来的那些格子。多线路模式下取最完整的一条 —— 有一条线路是全的就说明
   * 数据到位了，另一条空着多半是那个探测任务本身没跑。
   *
   * 传 null 表示这台一条线路都没有数据（柱子整个是空的）。
   */
  buckets: readonly PingOverviewBucket[] | null;
  /** 后端窗口给了几格（0 = 旧版后端没这个字段，或者没收到过）。 */
  windowSlots: number;
  /** 其中被判成复印段丢掉的格数。 */
  droppedSlots: number;
  /** 节点最后一次上报的时刻，在线时为 null。 */
  offlineSince: number | null;
}

export interface NodePingHealth {
  uuid: string;
  /** 参与判定的格数（不含掉线格）。 */
  assessable: number;
  filled: number;
  gapRatio: number;
  backfillRatio: number;
  reasons: PingHealthReason[];
  suspect: boolean;
}

/**
 * 判一台节点。返回 null = 这台不参与判定（掉线太久、或后端本来就没探测它）。
 *
 * 「没探测它」和「探测了但数据是编的」必须分开：前者刷新也查不出行来，弹窗只会变成
 * 每次打开页面都被问一遍。区分办法是看后端有没有给过窗口 —— 给了格子就说明这台在探测。
 */
export function assessNodePingHealth(
  input: NodePingHealthInput,
  now = Date.now(),
): NodePingHealth | null {
  const { uuid, buckets, windowSlots, droppedSlots, offlineSince } = input;
  if (offlineSince != null && offlineSince > 0 && now - offlineSince > MAX_OFFLINE_MS) {
    return null;
  }

  const backfillRatio =
    windowSlots > 0 ? Math.min(1, Math.max(0, droppedSlots) / windowSlots) : 0;

  if (buckets == null || buckets.length === 0) {
    // 一条线路都没数据。后端连窗口都没给过，就当它不探测这台，别拿刷新去撞空；
    // 给过窗口（哪怕整段是复印件被丢光了）就说明它在探测，这才是最该刷的一台。
    if (windowSlots === 0) return null;
    return {
      uuid,
      assessable: 0,
      filled: 0,
      gapRatio: 1,
      backfillRatio,
      reasons: backfillRatio >= BACKFILL_RATIO_THRESHOLD ? ["gap", "backfilled"] : ["gap"],
      suspect: true,
    };
  }

  // 掉线格是「已知没有数据」，不算空缺 —— 红格子本来就是照实画的。
  const assessable = buckets.filter((bucket) => !bucket.offline).length;
  if (assessable < MIN_ASSESSABLE_BUCKETS) return null;
  const filled = buckets.filter(
    (bucket) => !bucket.offline && bucket.value != null,
  ).length;
  const gapRatio = 1 - filled / assessable;

  // 复印段只当理由，不当判据 —— 判据永远是「卡片上有没有空缺」。
  const suspect = gapRatio >= GAP_RATIO_THRESHOLD;
  const reasons: PingHealthReason[] = [];
  if (suspect) {
    reasons.push("gap");
    if (backfillRatio >= BACKFILL_RATIO_THRESHOLD) reasons.push("backfilled");
  }

  return { uuid, assessable, filled, gapRatio, backfillRatio, reasons, suspect };
}

export interface PingHealthSummary {
  /** 参与判定的节点数。 */
  assessed: number;
  suspects: number;
  /** 柱子明显空缺的节点数。 */
  gapNodes: number;
  /** 其中「空是因为后端整段返回了复印值」的节点数（gapNodes 的子集）。 */
  backfilledNodes: number;
}

export function summarizePingHealth(
  results: readonly (NodePingHealth | null)[],
): PingHealthSummary {
  let assessed = 0;
  let suspects = 0;
  let gapNodes = 0;
  let backfilledNodes = 0;
  for (const result of results) {
    if (!result) continue;
    assessed += 1;
    if (!result.suspect) continue;
    suspects += 1;
    if (result.reasons.includes("gap")) gapNodes += 1;
    if (result.reasons.includes("backfilled")) backfilledNodes += 1;
  }
  return { assessed, suspects, gapNodes, backfilledNodes };
}

/** 这一屏的成色值不值得弹窗打断用户。 */
export function shouldPromptPingRefresh(summary: PingHealthSummary): boolean {
  if (summary.assessed === 0 || summary.suspects === 0) return false;
  return summary.suspects / summary.assessed >= SUSPECT_RATIO_THRESHOLD;
}

/**
 * 一次刷新大概要让后端读多少行 D1。
 *
 * 口径和 CLAUDE.md 一致：一台节点一小时的行数 = `3600 ÷ 上报间隔`，一次刷新是各节点之和。
 * 这个数会随节点增减变，所以是现算的，不写死。
 */
export function estimateRefreshRowCount(
  reportIntervalsSeconds: readonly number[],
): number {
  let rows = 0;
  for (const interval of reportIntervalsSeconds) {
    const seconds =
      Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_REPORT_INTERVAL_SECONDS;
    rows += Math.round(3600 / seconds);
  }
  return rows;
}
