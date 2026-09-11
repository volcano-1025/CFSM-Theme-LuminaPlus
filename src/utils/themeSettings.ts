import type { ThemeSettings } from "@/types/cfsm";
import { DEFAULT_SURFACE_OPACITY, normalizeSurfaceOpacity } from "@/utils/background";
import {
  DEFAULT_COST_RATE_API_URL,
  normalizeCostIgnoredNodes,
  normalizeCostPremiums,
  normalizeCostRateApiUrl,
  type CostPremiumEntry,
} from "@/utils/cost";
import { normalizeNodeIdentityList } from "@/utils/nodeIdentity";
import { normalizeHomeGroupOrder } from "@/utils/homeNodes";
import {
  HOME_SORT_NATURAL_DIRECTION,
  isHomeSortDirection,
  isHomeSortField,
  type HomeSortDirection,
  type HomeSortField,
} from "@/utils/homeSort";
import {
  DEFAULT_HOMEPAGE_MULTI_PING_TASK_IDS,
  DEFAULT_HOMEPAGE_PING_TASK_ID,
  resolveDefaultHomepagePingTaskId,
  normalizeHomepageMultiPingTaskIds,
  normalizeHomepagePingTaskBindings,
  type HomepagePingTaskBindings,
} from "@/utils/pingTasks";
import {
  EMPTY_PING_LINE_OVERRIDES_BY_NODE,
  normalizePingLineOverridesByNode,
  type PingLineOverridesByNode,
} from "@/utils/pingLineOverrides";

export type Appearance = "system" | "light" | "dark";
export type NodeViewMode = "large" | "compact" | "mini" | "list";

export interface ResolvedThemeSettings {
  defaultAppearance: Appearance;
  desktopNodeViewMode: NodeViewMode;
  mobileNodeViewMode: NodeViewMode;
  enableAdminButton: boolean;
  showPingChart: boolean;
  homepagePingBindings: HomepagePingTaskBindings;
  homepageDefaultPingTaskId: number;
  enableHomepageMultiPing: boolean;
  homepageMultiPingTaskIds: number[];
  homepagePingLineOverrides: PingLineOverridesByNode;
  fakePingForUnbound: boolean;
  showHomeOverview: boolean;
  showGroupTabs: boolean;
  showRegionBar: boolean;
  showCardGroup: boolean;
  showCardPrice: boolean;
  homeGroupOrder: string[];
  enableHomeSort: boolean;
  homeSortField: HomeSortField;
  homeSortDirection: HomeSortDirection;
  showCostSummary: boolean;
  showCostSummaryFloatingButton: boolean;
  showOverviewRatings: boolean;
  showTrafficRating: boolean;
  showBandwidthRating: boolean;
  showAssetRating: boolean;
  trafficRatingLabels: string;
  bandwidthRatingLabels: string;
  assetRatingLabels: string;
  compactShowTrafficTotal: boolean;
  compactShowBilling: boolean;
  compactShowUptime: boolean;
  showConnections: boolean;
  hiddenNodes: string[];
  costIgnoredNodes: string[];
  costPremiums: Record<string, CostPremiumEntry>;
  costRateApiUrl: string;
  surfaceOpacity: number;
}

export const DEFAULT_THEME_SETTINGS: ResolvedThemeSettings = {
  defaultAppearance: "system",
  desktopNodeViewMode: "large",
  mobileNodeViewMode: "compact",
  enableAdminButton: true,
  showPingChart: true,
  homepagePingBindings: {},
  homepageDefaultPingTaskId: DEFAULT_HOMEPAGE_PING_TASK_ID,
  enableHomepageMultiPing: true,
  homepageMultiPingTaskIds: [...DEFAULT_HOMEPAGE_MULTI_PING_TASK_IDS],
  homepagePingLineOverrides: EMPTY_PING_LINE_OVERRIDES_BY_NODE,
  fakePingForUnbound: false,
  showHomeOverview: true,
  showGroupTabs: true,
  showRegionBar: true,
  showCardGroup: true,
  showCardPrice: true,
  homeGroupOrder: [],
  enableHomeSort: true,
  homeSortField: "default",
  homeSortDirection: HOME_SORT_NATURAL_DIRECTION.default,
  showCostSummary: true,
  showCostSummaryFloatingButton: true,
  showOverviewRatings: true,
  showTrafficRating: true,
  showBandwidthRating: true,
  showAssetRating: true,
  trafficRatingLabels: "",
  bandwidthRatingLabels: "",
  assetRatingLabels: "",
  compactShowTrafficTotal: true,
  compactShowBilling: true,
  compactShowUptime: true,
  showConnections: false,
  hiddenNodes: [],
  costIgnoredNodes: [],
  costPremiums: {},
  costRateApiUrl: DEFAULT_COST_RATE_API_URL,
  surfaceOpacity: DEFAULT_SURFACE_OPACITY,
};

export function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * 后台「外观设置 → 默认外观」（`/api/config` 的 `preferred_theme`：auto / dark / light）→ 主题的外观值。
 * 缺席或认不出返回 undefined：老后端不下发，交给主题自己的默认（跟随系统）。
 */
export function resolvePreferredAppearance(value: unknown): Appearance | undefined {
  if (value === "dark" || value === "light") return value;
  if (value === "auto") return "system";
  return undefined;
}

/**
 * 把后台「默认外观」垫在主题设置的最底层：theme_options 或本机设置里写了 `defaultAppearance`
 * 就压过它。站长在后台改默认外观，没专门给主题配过外观的站点就会跟着走。
 */
export function withPreferredAppearance<T extends Record<string, unknown>>(
  preferred: Appearance | undefined,
  settings: T,
): T {
  return preferred ? ({ defaultAppearance: preferred, ...settings } as T) : settings;
}

function normalizeAppearance(
  value: unknown,
  fallback: Appearance = DEFAULT_THEME_SETTINGS.defaultAppearance,
): Appearance {
  return isAppearance(value) ? value : fallback;
}

export function isNodeViewMode(value: unknown): value is NodeViewMode {
  return value === "large" || value === "compact" || value === "mini" || value === "list";
}

function normalizeNodeViewMode(
  value: unknown,
  fallback: NodeViewMode,
): NodeViewMode {
  if (isNodeViewMode(value)) return value;
  // 未知旧字符串统一落到小卡，避免升级后出现无选中项。
  return typeof value === "string" && value.length > 0 ? "compact" : fallback;
}

// 列表档仅桌面可用(见 useViewMode 的 MOBILE_VIEW_MODES)。移动端即便配置里存了 "list"
// (历史值/外部写入)也归一化回默认档,避免管理页无选中项、首页又强制回落 compact 的不一致。
function normalizeMobileNodeViewMode(
  value: unknown,
  fallback: NodeViewMode,
): NodeViewMode {
  const mode = normalizeNodeViewMode(value, fallback);
  return mode === "list" ? fallback : mode;
}

function enabledUnlessFalse(value: unknown) {
  return value !== false;
}

function normalizePlainText(value: unknown) {
  return typeof value === "string" ? value : "";
}

// 管理员默认排序:字段非法回落 default;方向非法时回落该字段的自然方向(文本升、数值降)。
function normalizeHomeSortDefault(
  field: unknown,
  direction: unknown,
): { homeSortField: HomeSortField; homeSortDirection: HomeSortDirection } {
  const homeSortField = isHomeSortField(field) ? field : "default";
  return {
    homeSortField,
    homeSortDirection: isHomeSortDirection(direction)
      ? direction
      : HOME_SORT_NATURAL_DIRECTION[homeSortField],
  };
}

export function normalizeThemeSettings(
  settings: (ThemeSettings & Record<string, unknown>) | null | undefined,
): ResolvedThemeSettings {
  // 没配过就给电信/联通/移动三条线路：多线路模式默认开着，一条任务 id 都没有会静默退回
  // 单线路，站长会以为开关没生效。显式配过就尊重原值 —— 条数由站长定（1~4 条都算配好了），
  // 只有空数组才回退单线路。
  const homepageMultiPingTaskIds =
    settings?.homepageMultiPingTaskIds == null
      ? [...DEFAULT_HOMEPAGE_MULTI_PING_TASK_IDS]
      : normalizeHomepageMultiPingTaskIds(settings.homepageMultiPingTaskIds);
  return {
    defaultAppearance: normalizeAppearance(settings?.defaultAppearance),
    desktopNodeViewMode: normalizeNodeViewMode(
      settings?.desktopNodeViewMode,
      DEFAULT_THEME_SETTINGS.desktopNodeViewMode,
    ),
    mobileNodeViewMode: normalizeMobileNodeViewMode(
      settings?.mobileNodeViewMode,
      DEFAULT_THEME_SETTINGS.mobileNodeViewMode,
    ),
    enableAdminButton: enabledUnlessFalse(settings?.enableAdminButton),
    showPingChart: enabledUnlessFalse(settings?.showPingChart),
    homepagePingBindings: normalizeHomepagePingTaskBindings(settings?.homepagePingBindings),
    // 单线路模式下「没单独绑过的节点显示哪条」。写死电信时，全站绑联通的站点每加一台新节点
    // 就多一条电信，站长还得记得回来手动绑（v1.2.14 修）。
    homepageDefaultPingTaskId: resolveDefaultHomepagePingTaskId(
      settings?.homepageDefaultPingTaskId,
    ),
    // 默认开：多数站点想要的就是多条线路对比（默认给三条，沿用「三网」时代的口径）。
    // 保留开关原值（含显式 false），让管理页能呈现并修复空配置；首页消费方在任务
    // 至少一条时启用（见 isHomepageMultiPingConfigured）。
    enableHomepageMultiPing: enabledUnlessFalse(settings?.enableHomepageMultiPing),
    homepageMultiPingTaskIds,
    // 站长在卡片上点线路名换好、「保存到后端」写上来的逐节点换线（行号 → 线路 id）。线路 id 这里只校验
    // 是正整数（util 层不认线路表）；本机那份在 pingLineOverrideStore 里另按线路表筛。
    homepagePingLineOverrides: normalizePingLineOverridesByNode(settings?.homepagePingLineOverrides),
    // 默认关闭(需手动开启):给访客展示的是模拟数据,必须由站长显式决定。
    fakePingForUnbound: settings?.fakePingForUnbound === true,
    showHomeOverview: enabledUnlessFalse(settings?.showHomeOverview),
    showGroupTabs: enabledUnlessFalse(settings?.showGroupTabs),
    showRegionBar: enabledUnlessFalse(settings?.showRegionBar),
    showCardGroup: enabledUnlessFalse(settings?.showCardGroup),
    showCardPrice: enabledUnlessFalse(settings?.showCardPrice),
    homeGroupOrder: normalizeHomeGroupOrder(settings?.homeGroupOrder),
    enableHomeSort: enabledUnlessFalse(settings?.enableHomeSort),
    ...normalizeHomeSortDefault(settings?.homeSortField, settings?.homeSortDirection),
    showCostSummary: enabledUnlessFalse(settings?.showCostSummary),
    showCostSummaryFloatingButton: enabledUnlessFalse(settings?.showCostSummaryFloatingButton),
    showOverviewRatings: enabledUnlessFalse(settings?.showOverviewRatings),
    showTrafficRating: enabledUnlessFalse(settings?.showTrafficRating),
    showBandwidthRating: enabledUnlessFalse(settings?.showBandwidthRating),
    showAssetRating: enabledUnlessFalse(settings?.showAssetRating),
    trafficRatingLabels: normalizePlainText(settings?.trafficRatingLabels),
    bandwidthRatingLabels: normalizePlainText(settings?.bandwidthRatingLabels),
    assetRatingLabels: normalizePlainText(settings?.assetRatingLabels),
    compactShowTrafficTotal: enabledUnlessFalse(settings?.compactShowTrafficTotal),
    compactShowBilling: enabledUnlessFalse(settings?.compactShowBilling),
    compactShowUptime: enabledUnlessFalse(settings?.compactShowUptime),
    // 默认关闭(需手动开启):连接数是个小众指标,很多 agent 也不上报,所以只在显式启用时才显示。
    showConnections: settings?.showConnections === true,
    hiddenNodes: normalizeNodeIdentityList(settings?.hiddenNodes),
    costIgnoredNodes: normalizeCostIgnoredNodes(settings?.costIgnoredNodes),
    costPremiums: normalizeCostPremiums(settings?.costPremiums),
    costRateApiUrl: normalizeCostRateApiUrl(settings?.costRateApiUrl),
    // 默认开:让已配置背景图的存量站点升级后行为不变;关闭 = 保留 URL 但不加载背景图。
    surfaceOpacity: normalizeSurfaceOpacity(settings?.surfaceOpacity),
  };
}
