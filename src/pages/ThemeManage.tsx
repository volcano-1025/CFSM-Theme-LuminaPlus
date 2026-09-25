import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Coins,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardCopy,
  Cloud,
  CloudAlert,
  CloudDownload,
  CloudOff,
  EyeOff,
  Grid3x3,
  LayoutTemplate,
  LayoutGrid,
  List,
  ListFilter,
  Moon,
  Network,
  Plus,
  Rows3,
  Save,
  Search,
  Sparkles,
  Sun,
  SunMoon,
  Wallpaper,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { InstancePanel } from "@/components/instance/InstancePanel";
import { Spinner } from "@/components/ui/Spinner";
import { Flag } from "@/components/ui/Flag";
import { useCarrierNames, usePublicConfig } from "@/hooks/usePublicConfig";
import { useHourlyClock } from "@/hooks/useClock";
import { useAllPingLineOverrides } from "@/hooks/usePingOverview";
import {
  cancelSiteThemeSync,
  hasUnsyncedLocalChanges,
  useCanSyncSiteTheme,
  useSiteThemeOptions,
  useSiteThemeSyncStatus,
  type SiteThemeSyncPhase,
} from "@/hooks/useSiteThemeOptions";
import { useLocalThemeSettings } from "@/hooks/useThemeSettings";
import { getNodes } from "@/services/api";
import { carrierPingTasks } from "@/services/cfsm/mappers";
import { clearPingLineOverrides } from "@/services/pingLineOverrideStore";
import {
  getLocalThemeSettings,
  resetLocalThemeSettings,
  saveLocalThemeSettings,
} from "@/services/themeSettingsStore";
import { copyText } from "@/utils/clipboard";
import type { NodeInfo, PingTask, ThemeSettings } from "@/types/cfsm";
import {
  calculateCostSummary,
  calculateCostPremiumAmount,
  calculateCostPremiumBasisAt,
  formatCnyMoney,
  formatSignedCny,
  getExchangeRates,
  isCostRateApiUrlValid,
  normalizeCostIgnoredNodes,
  normalizeCostPremiums,
  normalizeCostRateApiUrl,
  type CostPremiumEntry,
} from "@/utils/cost";
import { normalizeNodeIdentityList } from "@/utils/nodeIdentity";
import { MAX_RENEWAL_REMINDER_DAYS } from "@/utils/renewalReminder";
import {
  dedupeGroupLabels,
  normalizeHomeGroupOrder,
  normalizeHomeRegionOrder,
  sortHomeGroupOptions,
} from "@/utils/homeNodes";
import {
  HOMEPAGE_MULTI_PING_MAX_COUNT,
  HOMEPAGE_MULTI_PING_MIN_COUNT,
  assignHomepageMultiPingTask,
  isHomepageMultiPingConfigured,
  normalizeHomepageMultiPingTaskIds,
  normalizeHomepagePingTaskBindings,
  type HomepagePingTaskBindings,
} from "@/utils/pingTasks";
import {
  DEFAULT_THEME_SETTINGS,
  normalizeThemeSettings,
  withPreferredAppearance,
  type ResolvedThemeSettings,
} from "@/utils/themeSettings";
import {
  getDefaultOverviewRatingLabelText,
  type OverviewRatingKind,
} from "@/utils/overviewRating";
import { HOME_SORT_FIELDS, HOME_SORT_FIELD_LABELS } from "@/utils/homeSort";

const APPEARANCE_OPTIONS = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "system", label: "跟随系统", icon: SunMoon },
  { value: "dark", label: "深色", icon: Moon },
] as const;
const NODE_VIEW_MODE_OPTIONS = [
  { value: "large", label: "大卡片", icon: LayoutGrid },
  { value: "compact", label: "小卡片", icon: Rows3 },
  { value: "mini", label: "迷你卡片", icon: Grid3x3 },
  { value: "list", label: "列表", icon: List },
] as const;
const MOBILE_VIEW_MODE_OPTIONS = NODE_VIEW_MODE_OPTIONS.filter((option) => option.value !== "list");

// 大卡片/小卡片显示单条还是多条线路。value 直接是 enableHomepageMultiPing 的布尔值。
const HOMEPAGE_PING_MODE_OPTIONS = [
  { value: false, label: "单线路", icon: Rows3 },
  { value: true, label: "多线路", icon: ListFilter },
] as const;

function localDateInputMax() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

const OVERVIEW_RATING_LABEL_FIELDS: Array<{
  key: OverviewRatingKind;
  title: string;
  toggleKey: "showTrafficRating" | "showBandwidthRating" | "showAssetRating";
}> = [
  { key: "traffic", title: "累计流量", toggleKey: "showTrafficRating" },
  { key: "bandwidth", title: "实时带宽", toggleKey: "showBandwidthRating" },
  { key: "asset", title: "资产概览", toggleKey: "showAssetRating" },
];

function sortTasks(tasks: PingTask[]) {
  return [...tasks].sort((left, right) => {
    if (left.weight !== right.weight) return left.weight - right.weight;
    if (left.id !== right.id) return left.id - right.id;
    return left.name.localeCompare(right.name);
  });
}

function buildPremiumEntry(
  amount: number,
  paidCny?: number,
  acquiredAt?: string,
): CostPremiumEntry {
  return {
    amount,
    ...(paidCny != null ? { paidCny } : {}),
    ...(acquiredAt ? { acquiredAt } : {}),
  };
}

function sortClients(clients: NodeInfo[]) {
  return [...clients].sort((left, right) => {
    if (left.weight !== right.weight) return left.weight - right.weight;
    return left.name.localeCompare(right.name);
  });
}

function filterClients(clients: NodeInfo[], rawKeyword: string) {
  const keyword = rawKeyword.trim().toLowerCase();
  if (!keyword) return clients;
  return clients.filter((client) => {
    const group = String(client.group || "").toLowerCase();
    const region = String(client.region || "").toLowerCase();
    return (
      client.name.toLowerCase().includes(keyword) ||
      client.uuid.toLowerCase().includes(keyword) ||
      group.includes(keyword) ||
      region.includes(keyword)
    );
  });
}

function summarizeNodes(
  uuids: string[],
  clientsById: Map<string, NodeInfo>,
) {
  if (uuids.length === 0) return "点右侧「编辑节点」把节点加进来";
  const names = uuids.map((uuid) => clientsById.get(uuid)?.name || uuid);
  const summary = names.join("、");
  return summary.length > 92 ? `${summary.slice(0, 92)}...` : summary;
}

function pruneBindings(bindings: HomepagePingTaskBindings) {
  const normalized = normalizeHomepagePingTaskBindings(bindings);
  const pruned: HomepagePingTaskBindings = {};

  for (const [taskId, clients] of Object.entries(normalized)) {
    if (clients.length > 0) {
      pruned[taskId] = clients;
    }
  }

  return pruned;
}

function applyClientAssignment(
  bindings: HomepagePingTaskBindings,
  taskId: number,
  clientUuid: string,
  checked: boolean,
) {
  const taskKey = String(taskId);
  const next = pruneBindings(bindings);

  for (const [currentTaskId, clients] of Object.entries(next)) {
    const filtered = clients.filter((uuid) => uuid !== clientUuid);
    if (filtered.length > 0) {
      next[currentTaskId] = filtered;
    } else {
      delete next[currentTaskId];
    }
  }

  if (checked) {
    const selected = next[taskKey] ?? [];
    next[taskKey] = Array.from(new Set([...selected, clientUuid])).sort((left, right) =>
      left.localeCompare(right),
    );
  }

  return next;
}

// 反查:client uuid → 所属 task id(字符串 key)。UI 保证每个 client 最多归属一个
// task,所以简单的后写覆盖 map 就是精确的。下面的「全选可用」reducer 和每次渲染的
// 可选节点过滤共用它,把「某 client 归属哪个 task」的推导收在一处。
function invertBindings(bindings: HomepagePingTaskBindings): Map<string, string> {
  const assignedTaskByClient = new Map<string, string>();
  for (const [taskId, clients] of Object.entries(bindings)) {
    for (const clientUuid of clients) {
      assignedTaskByClient.set(clientUuid, taskId);
    }
  }
  return assignedTaskByClient;
}

function applyAvailableClientAssignments(
  bindings: HomepagePingTaskBindings,
  taskId: number,
  clientUuids: string[],
) {
  const taskKey = String(taskId);
  const next = pruneBindings(bindings);
  const assignedTaskByClient = invertBindings(next);
  const selected = new Set(next[taskKey] ?? []);

  for (const clientUuid of clientUuids) {
    const assignedTaskId = assignedTaskByClient.get(clientUuid);
    if (assignedTaskId && assignedTaskId !== taskKey) continue;
    selected.add(clientUuid);
  }

  if (selected.size > 0) {
    next[taskKey] = [...selected].sort((left, right) => left.localeCompare(right));
  } else {
    delete next[taskKey];
  }

  return next;
}

// 本页托管设置的键清单唯一来源:草稿类型(ThemeDraft)、seed(draftFromSettings)与内容签名
// 都从它派生。新增一项设置只需在这里加一行,再到 JSX 里接 patch()。
// 刻意不标注返回类型:让推断给出全字段必填的具体类型,ThemeDraft 才能安全地 Omit/扩展。
function pickManagedThemeSettings(settings: ResolvedThemeSettings) {
  return {
    defaultAppearance: settings.defaultAppearance,
    desktopNodeViewMode: settings.desktopNodeViewMode,
    mobileNodeViewMode: settings.mobileNodeViewMode,
    homepagePingBindings: settings.homepagePingBindings,
    homepageDefaultPingTaskId: settings.homepageDefaultPingTaskId,
    enableHomepageMultiPing: settings.enableHomepageMultiPing,
    homepageMultiPingTaskIds: settings.homepageMultiPingTaskIds,
    showHomeOverview: settings.showHomeOverview,
    showAssetOverview: settings.showAssetOverview,
    showGroupTabs: settings.showGroupTabs,
    showRegionBar: settings.showRegionBar,
    showCardGroup: settings.showCardGroup,
    showCardPrice: settings.showCardPrice,
    homeGroupOrder: settings.homeGroupOrder,
    homeRegionOrder: settings.homeRegionOrder,
    homeDefaultGroup: settings.homeDefaultGroup,
    enableHomeSort: settings.enableHomeSort,
    homeSortField: settings.homeSortField,
    homeSortDirection: settings.homeSortDirection,
    offlineNodesFirst: settings.offlineNodesFirst,
    showCostSummary: settings.showCostSummary,
    renewalReminderDays: settings.renewalReminderDays,
    showOverviewRatings: settings.showOverviewRatings,
    showTrafficRating: settings.showTrafficRating,
    showBandwidthRating: settings.showBandwidthRating,
    showAssetRating: settings.showAssetRating,
    trafficRatingLabels: settings.trafficRatingLabels,
    bandwidthRatingLabels: settings.bandwidthRatingLabels,
    assetRatingLabels: settings.assetRatingLabels,
    compactShowTrafficTotal: settings.compactShowTrafficTotal,
    compactShowBilling: settings.compactShowBilling,
    compactShowUptime: settings.compactShowUptime,
    showConnections: settings.showConnections,
    hiddenNodes: settings.hiddenNodes,
    costIgnoredNodes: settings.costIgnoredNodes,
    // 按键排序:costPremiums 的键序随编辑历史漂移(删掉再加回同一键会排到最后),而 dirty /
    // reseed 判断都走 JSON.stringify 签名——不排序会把"内容相同、键序不同"误判成有未保存改动。
    costPremiums: Object.fromEntries(
      Object.keys(settings.costPremiums)
        .sort()
        .map((uuid) => [uuid, settings.costPremiums[uuid]]),
    ),
    costRateApiUrl: settings.costRateApiUrl,
    surfaceOpacity: settings.surfaceOpacity,
  };
}

function managedSettingsSignature(settings: ThemeSettings & Record<string, unknown>) {
  return JSON.stringify(pickManagedThemeSettings(normalizeThemeSettings(settings)));
}

type ManagedThemeSettings = ReturnType<typeof pickManagedThemeSettings>;

// 表单草稿:与托管设置同名同构,仅三处以「编辑态」存储——隐藏/忽略列表在表单里是多行文本
// (提交时再归一化回数组),三个评级名称合成按 kind 索引的对象(UI 按 OVERVIEW_RATING_LABEL_FIELDS
// 循环渲染)。其余字段直接透传,不维护第二份键清单。
type ThemeDraft = Omit<
  ManagedThemeSettings,
  | "hiddenNodes"
  | "costIgnoredNodes"
  | "trafficRatingLabels"
  | "bandwidthRatingLabels"
  | "assetRatingLabels"
> & {
  ratingLabels: Record<OverviewRatingKind, string>;
  hiddenNodesText: string;
  costIgnoredText: string;
};

// 服务端设置 → 表单草稿。reseed effect 和重置按钮都经 seedDrafts 走这里。
export function draftFromSettings(settings: ResolvedThemeSettings): ThemeDraft {
  const {
    hiddenNodes,
    costIgnoredNodes,
    trafficRatingLabels,
    bandwidthRatingLabels,
    assetRatingLabels,
    ...rest
  } = pickManagedThemeSettings(settings);
  return {
    ...rest,
    ratingLabels: {
      traffic: trafficRatingLabels,
      bandwidth: bandwidthRatingLabels,
      asset: assetRatingLabels,
    },
    hiddenNodesText: hiddenNodes.join("\n"),
    costIgnoredText: costIgnoredNodes.join("\n"),
  };
}

/**
 * 设置变了（别的设备改过、同步前重拉了 config）时的新草稿：用户改过的项（和上次灌进来的底不一样）留着，
 * 其余换成新值。原来是「表单有改动就整份不灌」—— 草稿里没改的几十项就一直是打开页面时那份，
 * 自动保存时又当成改动存回去，站长在别的设备上的改动被这台设备的旧值整份盖掉。
 */
export function rebaseDraft(current: ThemeDraft, base: ThemeDraft, next: ThemeDraft): ThemeDraft {
  const out: Record<string, unknown> = { ...next };
  for (const key of Object.keys(next) as (keyof ThemeDraft)[]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(base[key])) out[key] = current[key];
  }
  return out as ThemeDraft;
}

/**
 * 自动保存只存和当前设置不一样的项。存整份的话，本机就有了每一项的副本，站长那边整份同步上去，
 * 别的设备改过、这台没动过的项也会被写回这台设备看到的旧值。
 */
export function changedManagedSettings(
  draftSettings: ThemeSettings,
  source: ResolvedThemeSettings,
): Record<string, unknown> {
  const draftManaged = pickManagedThemeSettings(
    normalizeThemeSettings(draftSettings as ThemeSettings & Record<string, unknown>),
  );
  const sourceManaged = pickManagedThemeSettings(source);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(draftManaged) as (keyof ManagedThemeSettings)[]) {
    if (JSON.stringify(draftManaged[key]) !== JSON.stringify(sourceManaged[key])) {
      out[key] = (draftSettings as Record<string, unknown>)[key];
    }
  }
  return out;
}

type BooleanDraftKey = {
  [K in keyof ThemeDraft]: ThemeDraft[K] extends boolean ? K : never;
}[keyof ThemeDraft];

// 统一的「标题 + 说明 + 开关」行。memo + 稳定的 patch 引用:编辑无关字段的击键不再重渲这些行。
const ToggleRow = memo(function ToggleRow({
  field,
  title,
  desc,
  checked,
  onPatch,
}: {
  field: BooleanDraftKey;
  title: string;
  desc: string;
  checked: boolean;
  onPatch: (key: BooleanDraftKey, value: boolean) => void;
}) {
  return (
    <label className="surface-inset flex items-center justify-between gap-3 px-4 py-3">
      <span className="min-w-0">
        <span className="block setting-subhead-title">{title}</span>
        <span className="mt-1 block setting-hint">{desc}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onPatch(field, event.target.checked)}
        className="h-4 w-4 shrink-0 accent-[var(--accent-500)]"
      />
    </label>
  );
});

// 设置页的下拉框：原生箭头贴着右边框，这里隐藏它、自己画一个，左右都缩进 12px（样式见 .setting-select）。
function SettingSelect({
  wrapperClassName,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"select"> & { wrapperClassName?: string }) {
  return (
    <div className={clsx("setting-select", wrapperClassName)}>
      <select
        {...props}
        className={clsx(
          "surface-inset text-[13px] text-[var(--text-primary)] outline-none",
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown size={14} className="setting-select-icon" aria-hidden />
    </div>
  );
}

const EMPTY_ASSIGNED_CLIENTS: string[] = [];
const EMPTY_ADMIN_CLIENTS: NodeInfo[] = [];

// 单个 Ping 任务的绑定卡片。memo:编辑无关设置的击键不再重渲任务列表;展开态的
// tasks×clients 复选网格只在绑定/搜索/展开变化时重算。
const TaskBindingSection = memo(function TaskBindingSection({
  task,
  defaultTaskId,
  assigned,
  expanded,
  clientsById,
  visibleClients,
  assignedTaskByClientUuid,
  nodeSearch,
  onNodeSearch,
  onToggleExpand,
  onPatchBindings,
}: {
  task: PingTask;
  /** 站点当前的「默认线路」，用来给对应那张卡片打标。 */
  defaultTaskId: number;
  assigned: string[];
  expanded: boolean;
  clientsById: Map<string, NodeInfo>;
  visibleClients: NodeInfo[];
  assignedTaskByClientUuid: Map<string, string>;
  nodeSearch: string;
  onNodeSearch: (value: string) => void;
  onToggleExpand: (taskId: number) => void;
  onPatchBindings: (
    updater: (prev: HomepagePingTaskBindings) => HomepagePingTaskBindings,
  ) => void;
}) {
  // 绑定里存的是节点 ID，节点删了 ID 还留着（站长 2026-09-19：5 台节点显示「11 台」，多出来的 6 个
  // 全是删掉的节点、还只能显示成 ID）。台数和名单只算节点表里还在的；节点表没加载出来时先照存的显示。
  // 存的数据不动：访客的节点表里没有隐藏节点，按它删会把隐藏节点的绑定一起删掉。
  const existingAssigned =
    clientsById.size > 0 ? assigned.filter((uuid) => clientsById.has(uuid)) : assigned;
  const assignedSummary = summarizeNodes(existingAssigned, clientsById);
  // 探测线路是后端固定的，没绑定的节点会落到站长选的「默认线路」，这里标出来免得站长
  // 以为「0 个节点」就是没人用它。
  const isDefaultTask = task.id === defaultTaskId;
  // 过滤只有展开的任务需要;收起的卡片跳过,搜索输入不再对每个任务做 O(clients) 扫描。
  const selectableVisibleClients = expanded
    ? visibleClients.filter((client) => {
        const assignedTaskId = assignedTaskByClientUuid.get(client.uuid);
        return !assignedTaskId || assignedTaskId === String(task.id);
      })
    : EMPTY_ADMIN_CLIENTS;
  const allVisibleSelectableAssigned =
    selectableVisibleClients.length > 0 &&
    selectableVisibleClients.every((client) => assigned.includes(client.uuid));
  return (
    <section className="surface-inset px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">
              {task.name || `任务 #${task.id}`}
            </h3>
            {isDefaultTask && (
              <span className="rounded-full border border-[var(--hairline)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">
                默认线路
              </span>
            )}
          </div>
          <div className="mt-2 text-[12px] text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">
              {existingAssigned.length > 0
                ? `${existingAssigned.length} 台节点在首页显示这条线路的延迟`
                : "还没有节点选这条线路"}
            </span>
            {isDefaultTask && (
              <>
                <span className="mx-2 text-[var(--text-tertiary)]">·</span>
                <span>没单独指定线路的节点都走这条</span>
              </>
            )}
          </div>
          <p className="mt-2 text-[12px] text-[var(--text-tertiary)]" title={assignedSummary}>
            {assignedSummary}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {expanded && (
            <button
              type="button"
              disabled={selectableVisibleClients.length === 0 || allVisibleSelectableAssigned}
              onClick={() => {
                onPatchBindings((prev) =>
                  applyAvailableClientAssignments(
                    prev,
                    task.id,
                    selectableVisibleClients.map((client) => client.uuid),
                  ),
                );
              }}
              className="theme-manage-button is-compact"
            >
              {allVisibleSelectableAssigned ? "已全选可用" : "全选可用"}
            </button>
          )}
          {existingAssigned.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onPatchBindings((prev) => {
                  const next = { ...prev };
                  delete next[String(task.id)];
                  return pruneBindings(next);
                });
              }}
              className="theme-manage-button is-compact is-danger"
            >
              清空节点
            </button>
          )}
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => onToggleExpand(task.id)}
            className="theme-manage-button is-compact"
          >
            {expanded ? "收起节点" : "编辑节点"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 border-t border-[var(--hairline)] pt-4">
          <label className="surface-inset flex items-center gap-2 px-3 py-2">
            <Search size={14} className="text-[var(--text-tertiary)]" />
            <input
              value={nodeSearch}
              onChange={(event) => onNodeSearch(event.target.value)}
              placeholder="搜索节点名称 / UUID / 分组 / 地区"
              aria-label="搜索节点"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </label>

          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {visibleClients.map((client) => {
              const checked = assigned.includes(client.uuid);
              const subtitle = [client.group, client.uuid].filter(Boolean).join(" · ");
              return (
                <label
                  key={client.uuid}
                  className={clsx(
                    "flex cursor-pointer items-start gap-3 rounded-[12px] border px-3 py-3 transition-colors",
                    checked
                      ? "border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--hover-bg)_72%,transparent)]"
                      : "border-[var(--hairline)] bg-transparent hover:bg-[var(--hover-bg)]",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const nextChecked = event.target.checked;
                      onPatchBindings((prev) =>
                        applyClientAssignment(prev, task.id, client.uuid, nextChecked),
                      );
                    }}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent-500)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Flag region={client.region} size={14} />
                      <span className="truncate setting-subhead-title">
                        {client.name}
                      </span>
                    </div>
                    <div className="mt-1 setting-hint">
                      {subtitle || client.region || "未设置分组"}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
});

type PremiumDetail = ReturnType<typeof calculateCostSummary>["details"][number];

// 溢价录入列表。memo:编辑其他设置的击键不重渲整表——引用变化只来自
// costPremiums 切片、搜索结果与汇率加载态。
const PremiumList = memo(function PremiumList({
  clients,
  costPremiums,
  detailByUuid,
  rateLoading,
  acquiredAtMax,
  onPatchPaid,
  onPatchAcquiredAt,
}: {
  clients: NodeInfo[];
  costPremiums: ThemeDraft["costPremiums"];
  detailByUuid: Map<string, PremiumDetail>;
  rateLoading: boolean;
  acquiredAtMax: string;
  onPatchPaid: (uuid: string, rawValue: string) => void;
  onPatchAcquiredAt: (uuid: string, rawValue: string) => void;
}) {
  return (
    <div className="surface-inset max-h-[320px] overflow-y-auto">
      {clients.map((client) => {
        const entry = costPremiums[client.uuid];
        const detail = detailByUuid.get(client.uuid);
        const referenceLabel = rateLoading
          ? "计算中"
          : detail
            ? detail.counted
              ? formatCnyMoney(detail.remainingCny)
              : detail.note || "--"
            : "--";
        const canCompute = detail != null && (detail.counted || detail.note === "免费");
        return (
          <div
            key={client.uuid}
            className="flex items-center justify-between gap-3 border-b border-[var(--hairline)] px-3 py-2 last:border-b-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Flag region={client.region ?? ""} size={13} />
              <span
                className="truncate text-[13px] text-[var(--text-primary)]"
                title={client.name}
              >
                {client.name}
              </span>
              <span
                className="shrink-0 setting-hint"
                title="该节点当前剩余价值（按账单周期折算，不含溢价）"
              >
                {referenceLabel}
              </span>
              {entry && (
                <span
                  className="shrink-0 text-[11px] font-medium"
                  style={{
                    color:
                      entry.amount > 0
                        ? "var(--status-error)"
                        : entry.amount < 0
                          ? "var(--status-success)"
                          : "var(--text-tertiary)",
                  }}
                  title={
                    entry.paidCny != null
                      ? "溢价 = 收购价 − 收购日剩余价值；该折算基准已经固化"
                      : "旧格式：直接记录的溢价，填写收购价后自动升级"
                  }
                >
                  溢价 {formatSignedCny(entry.amount)}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={entry?.paidCny ?? ""}
                onChange={(event) => {
                  // 键入 `-`/`e` 等非法中间态时 value 为空串,不能误当"留空即清除"删掉记录。
                  if (event.target.validity.badInput) return;
                  onPatchPaid(client.uuid, event.target.value);
                }}
                placeholder="收购价"
                disabled={!canCompute}
                aria-label={`${client.name} 的收购价`}
                title={
                  canCompute
                    ? "实际收购价（人民币），留空即清除记录"
                    : "该节点已忽略或汇率缺失，无法折算剩余价值"
                }
                className="surface-inset w-24 px-2 py-1 text-right text-[13px] outline-none disabled:opacity-45"
              />
              <input
                type="date"
                max={acquiredAtMax}
                value={entry?.acquiredAt ?? ""}
                onChange={(event) => onPatchAcquiredAt(client.uuid, event.target.value)}
                // 与收购价同门槛:汇率/基准未就绪时 patchPremiumAcquiredAt 无法回算,
                // 放开输入只会被静默丢弃(受控值弹回旧日期)。
                disabled={!entry || !canCompute}
                aria-label={`${client.name} 的收购日期`}
                title={
                  canCompute
                    ? "收购日期：修改后会按当前价格、周期、到期日和汇率回算该日剩余价值，重新计算并固化溢价"
                    : "该节点已忽略或汇率缺失，无法折算剩余价值"
                }
                className="surface-inset w-[8.75rem] px-2 py-1 text-[12px] outline-none disabled:opacity-45"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
});

/* ------------------------------------------------------------------ *
 * 设置分组与搜索直达
 * ------------------------------------------------------------------ */

type ThemeTabId = "appearance" | "home" | "card" | "cost" | "ping";

/**
 * 设置按分组分页，一次只渲染一组。
 *
 * 原来九个分区一条直线排下来：桌面 4100px（5.4 屏）、手机 6000px（6.7 屏），节点越多越长，
 * 改一项设置要把整页扫一遍。分组后一组只剩 1~2 屏，顶栏和分组导航都钉住不动，来回改也不用滚。
 * 加新设置时一并想好放哪一组。
 */
const THEME_TABS: ReadonlyArray<{
  id: ThemeTabId;
  label: string;
  hint: string;
  icon: typeof LayoutTemplate;
}> = [
  { id: "appearance", label: "外观", hint: "外观、卡片尺寸、透明度", icon: LayoutTemplate },
  { id: "home", label: "首页", hint: "总览、排序、隐藏节点", icon: ListFilter },
  { id: "card", label: "卡片", hint: "卡片上显示哪些信息", icon: Rows3 },
  { id: "cost", label: "花费", hint: "资产统计与收购溢价", icon: CircleDollarSign },
  { id: "ping", label: "延迟", hint: "线路与逐节点指定", icon: Activity },
];

const DEFAULT_THEME_TAB: ThemeTabId = "appearance";

function isThemeTabId(value: string | null): value is ThemeTabId {
  return value != null && THEME_TABS.some((tab) => tab.id === value);
}

/** 停手多久自动保存（站长那边之后还有自动同步自己的防抖，见 SITE_THEME_SYNC_DEBOUNCE_MS）。 */
const THEME_AUTO_SAVE_DEBOUNCE_MS = 600;

/** 设置区底部与页脚之间再留一点空（各层的内边距另算）。 */
const BODY_BOTTOM_GAP = 2;

/** 窗口再矮也给设置区留这么高，剩下的让整页滚。 */
const MIN_BODY_HEIGHT = 320;

/**
 * 工具栏上替代保存按钮的状态：谁都不用点保存 —— 站长的改动同步到后端，访客的存本机。
 * 同步失败的原因与「重试」在底部的 SiteThemeSyncNotice，这里只说结果。
 */
function SiteSyncIndicator({
  phase,
  invalid,
  waiting,
  toSite,
  savedLocally,
}: {
  phase: SiteThemeSyncPhase;
  invalid: boolean;
  waiting: boolean;
  /** 登录站长：存完还要发到后端；访客只存本机。 */
  toSite: boolean;
  /** 访客这次会话已经存过一次（站长看 phase）。 */
  savedLocally: boolean;
}) {
  const [icon, text] = invalid
    ? [
        <CloudOff key="off" size={14} />,
        toSite ? "有设置填得不对，暂未同步" : "有设置填得不对，暂未保存",
      ]
    : !toSite
      ? waiting
        ? [<Spinner key="spin" size={14} />, "正在保存到本机"]
        : savedLocally
          ? [<Save key="saved" size={14} />, "已保存到本机"]
          : [<Save key="local" size={14} />, "改动自动保存到本机"]
      : waiting || phase === "pending" || phase === "saving"
        ? [<Spinner key="spin" size={14} />, "正在同步到后端"]
        : phase === "error"
          ? [<CloudAlert key="alert" size={14} />, "同步到后端失败"]
          : phase === "synced"
            ? [<Cloud key="done" size={14} />, "已同步到后端"]
            : [<Cloud key="idle" size={14} />, "改动自动同步到后端"];
  return (
    <span
      role="status"
      aria-live="polite"
      className={clsx(
        "theme-manage-sync-status",
        (invalid || phase === "error") && "is-error",
      )}
    >
      {icon}
      <span>{text}</span>
    </span>
  );
}

export function ThemeManage() {
  const now = useHourlyClock();
  const {
    data: config,
    isLoading: configLoading,
    error: configError,
    refetch: refetchConfig,
  } = usePublicConfig();
  const carrierNames = useCarrierNames();
  // 全部托管设置收敛为单个草稿对象。之前是 30 个平行 useState,每新增一项设置要同步维护
  // 声明/seedDrafts/payload/依赖数组四处清单;现在键清单只在 pickManagedThemeSettings 一处。
  const [draft, setDraft] = useState<ThemeDraft>(() =>
    draftFromSettings(DEFAULT_THEME_SETTINGS),
  );
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null);
  // 分组页签记在地址里：刷新、后退、把链接发给别人都还在同一组。
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: ThemeTabId = isThemeTabId(tabParam) ? tabParam : DEFAULT_THEME_TAB;
  // 多线路模式下「单线路设置」默认收起（大/小卡片用不到它）。但不能删：迷你卡片与列表永远
  // 走单线路，这里是它们唯一的入口，所以留一个展开按钮。单线路模式下这块恒展开。
  const [taskSearch, setTaskSearch] = useState("");
  const [nodeSearch, setNodeSearch] = useState("");
  const [premiumSearch, setPremiumSearch] = useState("");
  // 访客的「已保存到本机」：这次会话存过一次才显示（站长那边看同步状态）。
  const [savedLocally, setSavedLocally] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 登录站长：改动自动保存并同步到后端，没有保存按钮（口径见 useCanSyncSiteTheme）。
  const canSaveToSite = useCanSyncSiteTheme();
  const siteSync = useSiteThemeSyncStatus();
  const editVersionRef = useRef(0);

  // 单字段更新收口,所有表单控件都走它。值未变时原样返回 prev,保留旧的独立 useState
  // 在同值 set 时不触发重渲染的行为。
  const patch = useCallback(
    <K extends keyof ThemeDraft>(key: K, value: ThemeDraft[K]) => {
      editVersionRef.current += 1;
      setDraft((prev) => (Object.is(prev[key], value) ? prev : { ...prev, [key]: value }));
    },
    [],
  );
  // 绑定关系的三个入口(勾选/全选/清空)都是基于前值的函数式更新,单独收口。
  const patchBindings = useCallback(
    (updater: (prev: HomepagePingTaskBindings) => HomepagePingTaskBindings) => {
      editVersionRef.current += 1;
      setDraft((prev) => ({
        ...prev,
        homepagePingBindings: updater(prev.homepagePingBindings),
      }));
    },
    [],
  );
  /**
   * 设置区是独立滚动区：顶栏固定，卡片只在自己的区域里滚，永远不会滑到顶栏那一块去。
   * 高度只能量出来 —— 顶栏高度随登录态和换行变化，页脚高度也随站点信息变。量完页面本身正好不用滚，
   * 只有窗口特别矮时才退回整页滚动（min-height 兜底）。
   */
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      // 只拿「和设置区自身高度无关」的量来算，否则每量一次都会漂：
      // 设置区在文档里的上沿（只受顶栏影响）、页脚自身高度、main 的下留白。
      // 别去量 main 或页脚的位置 —— 它们被这块撑着走，量出来会越算越大 / 越算越小。
      const top = rect.top + window.scrollY;
      const main = element.closest("main");
      // 设置区到 main 之间每一层的下内边距（页面下留白、.theme-manage 的 py-2 …）都要算上，
      // 少算一层页面就会多出那么几像素的滚动。
      let padBottom = 0;
      for (
        let node: HTMLElement | null = element.parentElement;
        node && main && (node === main || main.contains(node));
        node = node.parentElement
      ) {
        const style = window.getComputedStyle(node);
        padBottom +=
          parseFloat(style.paddingBottom || "0") + parseFloat(style.borderBottomWidth || "0");
        if (node === main) break;
      }
      const footerHeight =
        document.querySelector(".site-footer")?.getBoundingClientRect().height ?? 0;
      const available = window.innerHeight - top - footerHeight - padBottom - BODY_BOTTOM_GAP;
      element.style.setProperty("--theme-body-height", `${Math.max(MIN_BODY_HEIGHT, available)}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    // 顶栏换行（访客的按钮挤到第二行）、页脚多一行都会改变可用高度。
    const observer = new ResizeObserver(measure);
    const topbar = document.querySelector(".theme-topbar");
    const footer = document.querySelector(".site-footer");
    if (topbar) observer.observe(topbar);
    if (footer) observer.observe(footer);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

  const openTab = useCallback(
    (next: ThemeTabId) => {
      // replace：换分组不该在浏览器历史里堆一串，按返回要回首页。view 等其它参数原样保留。
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("tab", next);
          return params;
        },
        { replace: true },
      );
      // 换组回到这一组的顶部：滚的是设置区，不是整个页面。
      sectionsRef.current?.scrollTo({ top: 0 });
    },
    [setSearchParams],
  );

  const toggleTaskExpanded = useCallback((taskId: number) => {
    setExpandedTaskId((current) => (current === taskId ? null : taskId));
    setNodeSearch("");
  }, []);
  // 三个改线路的回调共用一段收尾：归一化（去重、按上限截断）后，值没变就返回原草稿，
  // 免得每次 onChange 都制造新对象让整页重渲染。
  const commitMultiPingTaskIds = useCallback(
    (mutate: (prev: number[]) => number[]) => {
      editVersionRef.current += 1;
      setDraft((prev) => {
        const homepageMultiPingTaskIds = normalizeHomepageMultiPingTaskIds(
          mutate([...prev.homepageMultiPingTaskIds]),
        );
        return JSON.stringify(homepageMultiPingTaskIds) ===
          JSON.stringify(prev.homepageMultiPingTaskIds)
          ? prev
          : { ...prev, homepageMultiPingTaskIds };
      });
    },
    [],
  );
  const patchMultiPingTask = useCallback(
    (slot: number, rawValue: string) => {
      commitMultiPingTaskIds((ids) => {
        if (rawValue === "") {
          ids.splice(slot, 1);
          return ids;
        }
        // 选了别的槽位已经在用的线路：两条互换，而不是禁用那个选项、逼站长先把那边改掉。
        return assignHomepageMultiPingTask(ids, slot, Number(rawValue));
      });
    },
    [commitMultiPingTaskIds],
  );
  const removeMultiPingTask = useCallback(
    (slot: number) => {
      commitMultiPingTaskIds((ids) => {
        ids.splice(slot, 1);
        return ids;
      });
    },
    [commitMultiPingTaskIds],
  );
  // 「添加线路」补的是第一条还没被选的线路，站长再按需改成别的；补不到就什么都不做
  // （按钮那时本来就是禁用的）。
  const addMultiPingTask = useCallback(() => {
    commitMultiPingTaskIds((ids) => {
      const nextTask = sortedTasksRef.current.find((task) => !ids.includes(task.id));
      if (nextTask) ids.push(nextTask.id);
      return ids;
    });
  }, [commitMultiPingTaskIds]);

  // CF-Server-Monitor 的探测线路由后端固定（八条，见 CARRIER_TASKS），没有可配置的 ping 任务列表；
  // 名字则跟着后端的 custom_*_name / node_N_name 走（站长改过就显示他改的）。
  const pingTasks = useMemo(() => carrierPingTasks(carrierNames), [carrierNames]);
  const tasksLoading = false;
  const {
    data: adminClients,
    isLoading: clientsLoading,
    error: clientsError,
  } = useQuery({
    queryKey: ["theme-manage", "node-meta"],
    queryFn: ({ signal }) => getNodes({ signal }),
    staleTime: 60_000,
    retry: 1,
  });

  // 「当前已保存的设置」= 站点预设 + 本机覆盖，和全站读取口径一致。
  // 只取后端的话，reseed 会在 config 到达后把草稿冲回站点默认值，
  // 用户会以为自己保存的设置丢了。
  const localThemeSettings = useLocalThemeSettings();
  // 首页卡片上点线路名换过的线路（另一份本机存储）。不归表单草稿管，只在拼 siteDefaults 快照时并进去。
  const localLineOverrides = useAllPingLineOverrides();
  const localLineOverrideCount = Object.keys(localLineOverrides).length;
  const sourceThemeSettings = useMemo(
    () =>
      normalizeThemeSettings(
        // 与全站读设置同口径：后台「默认外观」垫底（见 useThemeSettings），表单才显示实际生效的外观。
        withPreferredAppearance(config?.preferredAppearance, {
          ...(config?.theme_settings ?? {}),
          ...localThemeSettings,
        }),
      ),
    [config?.preferredAppearance, config?.theme_settings, localThemeSettings],
  );
  // 按内容判断服务端设置是否真的变化，避免同内容 refetch 重置草稿。
  const sourceSignature = useMemo(
    () => JSON.stringify(pickManagedThemeSettings(sourceThemeSettings)),
    [sourceThemeSettings],
  );
  const lastSeededSignatureRef = useRef<string | null>(null);
  /** 草稿是在哪份设置上改的（草稿形态）：rebaseDraft 据此分辨哪些项是用户改过的。 */
  const draftBaseRef = useRef<ThemeDraft | null>(null);

  // 把服务端设置灌入草稿的唯一出口,reseed effect 和重置按钮都走它,避免两边逻辑漂移。
  const seedDrafts = useCallback((next: ResolvedThemeSettings) => {
    const seeded = draftFromSettings(next);
    draftBaseRef.current = seeded;
    setDraft(seeded);
  }, []);

  const sortedTasks = useMemo(() => sortTasks(pingTasks), [pingTasks]);
  // 「添加线路」要挑「第一条还没选的」，但那个回调声明在 sortedTasks 之前、且不该因为
  // 线路名变化就重建（会连累整块表单重渲染），所以走 ref 读当前值。
  const sortedTasksRef = useRef(sortedTasks);
  sortedTasksRef.current = sortedTasks;
  // 能选几条：后端给几条线路就最多几条，再被主题的上限夹一次（后端以后加线路，
  // 抬 HOMEPAGE_MULTI_PING_MAX_COUNT 即可，这里不用动）。
  const multiPingSlotLimit = Math.min(
    HOMEPAGE_MULTI_PING_MAX_COUNT,
    Math.max(sortedTasks.length, HOMEPAGE_MULTI_PING_MIN_COUNT),
  );
  const sortedClients = useMemo(() => sortClients(adminClients ?? []), [adminClients]);
  const clientsById = useMemo(
    () => new Map(sortedClients.map((client) => [client.uuid, client])),
    [sortedClients],
  );

  // 后端实际存在的分组,按首页 Tab 的渲染顺序排列(已配置的在前,未排序的在后)。
  // 用户直接拖动这个列表来调整顺序。
  const availableGroups = useMemo(
    () => dedupeGroupLabels(sortedClients.map((client) => client.group)),
    [sortedClients],
  );
  const orderedDraftGroups = useMemo(
    () => sortHomeGroupOptions(availableGroups, draft.homeGroupOrder),
    [availableGroups, draft.homeGroupOrder],
  );
  const moveGroup = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= orderedDraftGroups.length) return;
    const next = [...orderedDraftGroups];
    [next[index], next[target]] = [next[target], next[index]];
    patch("homeGroupOrder", next);
  };

  const filteredTasks = useMemo(() => {
    const keyword = taskSearch.trim().toLowerCase();
    if (!keyword) return sortedTasks;
    // 探测方式/目标是主题拼出来的固定值（后端不下发），拿它们当搜索维度只会误导。
    return sortedTasks.filter((task) => task.name.toLowerCase().includes(keyword));
  }, [sortedTasks, taskSearch]);

  const visibleClients = useMemo(
    () => filterClients(sortedClients, nodeSearch),
    [nodeSearch, sortedClients],
  );
  const filteredPremiumClients = useMemo(
    () => filterClients(sortedClients, premiumSearch),
    [premiumSearch, sortedClients],
  );

  // 溢价表格里"当前剩余价值"仅供参考,用已保存的汇率源/忽略名单算(不用草稿里还没保存的
  // 编辑),口径与资产统计页完全一致(同一个 calculateCostSummary),但不叠加溢价本身。
  // 与上面的节点列表复用同一份查询：设置页只需要静态 meta，不该为一列参考值
  // 再挂一个常驻的实时轮询。
  const allMeta = sortedClients;
  const premiumRateQuery = useQuery({
    queryKey: ["cost-rates", sourceThemeSettings.costRateApiUrl],
    queryFn: ({ signal }) => getExchangeRates(sourceThemeSettings.costRateApiUrl, { signal }),
    staleTime: 60 * 60 * 1000,
    enabled: allMeta.length > 0,
    retry: 1,
  });
  const premiumDetailByUuid = useMemo(() => {
    const map = new Map<string, ReturnType<typeof calculateCostSummary>["details"][number]>();
    if (!premiumRateQuery.data) return map;
    const summary = calculateCostSummary(
      allMeta,
      sourceThemeSettings.costIgnoredNodes,
      premiumRateQuery.data.rates,
      undefined,
      now,
    );
    for (const detail of summary.details) map.set(detail.uuid, detail);
    return map;
  }, [allMeta, now, sourceThemeSettings.costIgnoredNodes, premiumRateQuery.data]);

  // 使用当前价格、周期、到期日和汇率回算指定收购日的剩余价值；结果只在用户编辑
  // 收购价/日期时用于固化溢价，不会因后续续费或汇率变化自动改写。
  const premiumBasisAt = useCallback(
    (uuid: string, acquiredAt?: string): number | null => {
      if (!premiumRateQuery.data) return null;
      if (!acquiredAt || acquiredAt === localDateInputMax()) {
        const detail = premiumDetailByUuid.get(uuid);
        if (!detail) return null;
        if (detail.note === "免费") return 0;
        return detail.counted ? detail.remainingCny : null;
      }
      return calculateCostPremiumBasisAt(
        allMeta,
        sourceThemeSettings.costIgnoredNodes,
        premiumRateQuery.data.rates,
        uuid,
        acquiredAt,
        now,
      );
    },
    [
      allMeta,
      now,
      premiumDetailByUuid,
      sourceThemeSettings.costIgnoredNodes,
      premiumRateQuery.data,
    ],
  );

  const premiumConfiguredCount = useMemo(
    () => Object.keys(draft.costPremiums).length,
    [draft.costPremiums],
  );

  // 收购价清空即删条目；溢价按收购日的回算剩余价值算出并固化，不随后续续费/汇率漂移。
  const patchPremiumPaid = useCallback(
    (uuid: string, rawValue: string) => {
      editVersionRef.current += 1;
      setDraft((prev) => {
        const next = { ...prev.costPremiums };
        if (rawValue.trim() === "") {
          if (!(uuid in next)) return prev;
          delete next[uuid];
          return { ...prev, costPremiums: next };
        }
        const paid = Number(rawValue);
        if (!Number.isFinite(paid) || paid < 0) return prev;
        const current = prev.costPremiums[uuid];
        if (current && Object.is(current.paidCny, paid)) return prev;
        const acquiredAt = current?.acquiredAt ?? localDateInputMax();
        const storedBasis =
          current?.paidCny != null ? current.paidCny - current.amount : Number.NaN;
        const basis = Number.isFinite(storedBasis)
          ? storedBasis
          : premiumBasisAt(uuid, acquiredAt);
        if (basis == null) return prev;
        next[uuid] = buildPremiumEntry(
          calculateCostPremiumAmount(paid, basis, current),
          paid,
          acquiredAt,
        );
        return { ...prev, costPremiums: next };
      });
    },
    [premiumBasisAt],
  );

  // 主动修改收购日期时重新回算该日剩余价值并固化新溢价；保存后仍保持固定。
  const patchPremiumAcquiredAt = useCallback(
    (uuid: string, rawValue: string) => {
      editVersionRef.current += 1;
      setDraft((prev) => {
        const current = prev.costPremiums[uuid];
        if (!current) return prev;
        const acquiredAt = rawValue.trim() || undefined;
        if (current.acquiredAt === acquiredAt) return prev;
        let amount = current.amount;
        if (acquiredAt && current.paidCny != null) {
          const basis = premiumBasisAt(uuid, acquiredAt);
          if (basis == null) return prev;
          amount = calculateCostPremiumAmount(current.paidCny, basis);
        }
        const next = { ...prev.costPremiums };
        next[uuid] = buildPremiumEntry(amount, current.paidCny, acquiredAt);
        return { ...prev, costPremiums: next };
      });
    },
    [premiumBasisAt],
  );

  const draftHiddenNodes = useMemo(
    () => normalizeNodeIdentityList(draft.hiddenNodesText),
    [draft.hiddenNodesText],
  );
  const draftCostRateApiUrlInvalid =
    draft.costRateApiUrl.trim() !== "" && !isCostRateApiUrlValid(draft.costRateApiUrl.trim());
  const draftMultiPingInvalid =
    draft.enableHomepageMultiPing &&
    !isHomepageMultiPingConfigured(draft.homepageMultiPingTaskIds);

  // 由当前草稿拼出的设置 payload,保存请求和 dirty 判断都用它。草稿字段与设置同名,这里只做
  // 「编辑态 → 存储态」的换形与归一化;文本域(hiddenNodesText/costIgnoredText)和 ratingLabels
  // 解构出来换回存储字段,其余原样透传。
  const draftThemeSettings = useMemo<ThemeSettings>(() => {
    const { ratingLabels, hiddenNodesText, costIgnoredText, ...rest } = draft;
    return {
      ...rest,
      homepagePingBindings: pruneBindings(rest.homepagePingBindings),
      homeGroupOrder: normalizeHomeGroupOrder(rest.homeGroupOrder),
      homeRegionOrder: normalizeHomeRegionOrder(rest.homeRegionOrder),
      trafficRatingLabels: ratingLabels.traffic,
      bandwidthRatingLabels: ratingLabels.bandwidth,
      assetRatingLabels: ratingLabels.asset,
      hiddenNodes: normalizeNodeIdentityList(hiddenNodesText),
      costIgnoredNodes: normalizeCostIgnoredNodes(costIgnoredText),
      costPremiums: normalizeCostPremiums(rest.costPremiums),
      costRateApiUrl: normalizeCostRateApiUrl(rest.costRateApiUrl),
    };
  }, [draft]);

  // 只比较本页实际管理的设置。enableAdminButton/showPingChart 这类隐藏设置会通过
  // baseSettings 在保存时保留,但不该让表单永远显示为 dirty。
  const draftSignature = useMemo(
    () => managedSettingsSignature(draftThemeSettings as ThemeSettings & Record<string, unknown>),
    [draftThemeSettings],
  );
  // draftSignature 用的是归一化后的 cost-rate URL,非法输入会被收敛回默认值,于是非法输入
  // 不会被判为 dirty,用户既无法保存也无法重置出来。所以单独跟踪原始文本,让编辑始终把表单
  // 标为 dirty(重置可用),而保存按钮再额外按合法性把关(见下文)。
  const costRateApiUrlDirty =
    draft.costRateApiUrl.trim() !== sourceThemeSettings.costRateApiUrl;
  const isDirty = draftSignature !== sourceSignature || costRateApiUrlDirty;

  // 用户重新编辑后清掉「已保存」提示,避免过期的成功提示和 dirty 表单并存。
  useEffect(() => {
    if (isDirty) setMessage(null);
  }, [isDirty]);

  // 服务端设置真正变化时灌入草稿。首次整份灌；之后按项合并（rebaseDraft）：用户改过、还没存的项留着，
  // 其余跟上新设置 —— refetch / 其他端保存的回流不会盖掉正在改的，没改的也不会停在旧值。
  useEffect(() => {
    if (!config) return;
    if (lastSeededSignatureRef.current === sourceSignature) return;
    lastSeededSignatureRef.current = sourceSignature;
    const base = draftBaseRef.current;
    if (base === null) {
      seedDrafts(sourceThemeSettings);
      return;
    }
    const next = draftFromSettings(sourceThemeSettings);
    draftBaseRef.current = next;
    setDraft((current) => rebaseDraft(current, base, next));
  }, [config, sourceSignature, sourceThemeSettings, seedDrafts]);

  // 每个 client 归属哪个 task 的反查,只在绑定草稿变化时重建。与「全选可用」reducer
  // 共用 invertBindings() 避免推导漂移,并把可选节点过滤保持在 O(tasks × clients),
  // 而不是每个 client 都重扫一遍 bindings。
  const assignedTaskByClientUuid = useMemo(
    () => invertBindings(draft.homepagePingBindings),
    [draft.homepagePingBindings],
  );

  // 「已单独指定 N / 共几台」：只数节点表里还在的。绑定里留着删掉的节点 ID，直接加总会出现
  // 「11 / 5 台」（见 TaskBindingSection 的 existingAssigned）。
  const assignedNodeCount = useMemo(() => {
    if (clientsById.size === 0) return assignedTaskByClientUuid.size;
    let count = 0;
    for (const uuid of assignedTaskByClientUuid.keys()) {
      if (clientsById.has(uuid)) count += 1;
    }
    return count;
  }, [assignedTaskByClientUuid, clientsById]);

  /**
   * 自动保存：表单一停手就把草稿存进本机；登录站长那边自动同步随即把它发到后端
   * （见 startSiteThemeAutoSync），访客的就只留在这台设备。两边都没有保存按钮。
   * 等人停手再存：打字时每个字都存一次，整站读设置的地方都跟着重算。填错了（汇率接口地址、多线路
   * 一条都没选）不存。
   *
   * **只认这次会话里真改过的**（`editVersionRef` 只在表单回调里加）：草稿播种和站点配置到达之间有一拍
   * 「默认值草稿 vs 已有设置」，不挡住的话，光打开设置页就会把这台设备本机存的旧设置存一遍
   * —— 站长那边接着被自动同步推到后端，盖掉他在别的设备上的配置。
   *
   * 存之前把 lastSeededSignatureRef 钉到这份草稿：否则存完「当前生效的设置」变了、表单又不再 dirty，
   * 灌草稿的 effect 会拿归一化后的设置重灌一遍 —— 正在输入的多行文本会被吞掉末尾的逗号和换行。
   */
  const autoSaveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    autoSaveRef.current = null;
    if (!config || editVersionRef.current === 0) return;
    if (draftSignature === sourceSignature) return;
    if (draftCostRateApiUrlInvalid || draftMultiPingInvalid) return;
    const save = () => {
      autoSaveRef.current = null;
      lastSeededSignatureRef.current = draftSignature;
      // 存完「当前设置」就是这份草稿，之后再来的新设置以它为底合并。
      draftBaseRef.current = draft;
      saveLocalThemeSettings({
        ...getLocalThemeSettings(),
        ...changedManagedSettings(draftThemeSettings, sourceThemeSettings),
      });
      setSavedLocally(true);
    };
    autoSaveRef.current = save;
    const timer = window.setTimeout(save, THEME_AUTO_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    config,
    draft,
    draftCostRateApiUrlInvalid,
    draftMultiPingInvalid,
    draftSignature,
    draftThemeSettings,
    sourceSignature,
    sourceThemeSettings,
  ]);
  // 停手不到防抖时长就离开设置页：把这次改动存上（站长的由自动同步在页面外照常发出去）。
  useEffect(() => () => autoSaveRef.current?.(), []);

  /**
   * 当前设置的完整站点快照，「复制配置 JSON」粘到后台「主题自定义配置」用（未登录时才有这个按钮）。
   * 含配色、卡片上换过的线路等本页之外的设置，拼法见 buildSiteThemeOptions（自动同步用的是同一份）。
   */
  const { snapshot: siteDefaults } = useSiteThemeOptions(draftThemeSettings);

  const siteDefaultsJson = useMemo(
    () => JSON.stringify(siteDefaults, null, 2),
    [siteDefaults],
  );

  const handleCopySiteDefaults = async () => {
    setError(null);
    if (await copyText(siteDefaultsJson)) {
      setCopied(true);
      setMessage("配置 JSON 已复制，粘贴到后台「外观设置 → 主题自定义配置」保存即可成为所有设备的默认值");
      window.setTimeout(() => setCopied(false), 2000);
      return;
    }
    setMessage(null);
    setError("复制失败，请检查浏览器的剪贴板权限");
  };

  /**
   * 清掉本地覆盖，回到后端 theme_options + 主题默认值。
   *
   * 工具栏的「改用后端配置」按钮走这里：本机存过的设置只要还在，后端改的配置就永远压不过来
   * （合并规则是本地覆盖优先），必须先把本地那份丢掉。登录站长的改动平时已经自动同步、本机是空的，
   * 所以只在本机还有没同步上的改动时才给这个按钮（见 hasUnsyncedLocalChanges）。
   */
  const handleRestoreSiteDefaults = () => {
    // 登录站长同步失败时，本机改动会一直等着重试；丢掉本机就不该再发出去。
    cancelSiteThemeSync();
    resetLocalThemeSettings();
    clearPingLineOverrides();
    // 表单同步回站点默认值：否则会留下一份"已被清除但仍显示"的脏草稿。
    seedDrafts(
      normalizeThemeSettings(
        withPreferredAppearance(config?.preferredAppearance, config?.theme_settings ?? {}),
      ),
    );
    setMessage("已丢弃本机设置，改用后端当前的配置");
    setError(null);
  };

  // 表单改了、还没到自动保存那一下（登录站长）。
  const draftAwaitingAutoSave = draftSignature !== sourceSignature;
  const siteHasUnsyncedChanges = hasUnsyncedLocalChanges({
    hasLocalChanges: Object.keys(localThemeSettings).length > 0 || localLineOverrideCount > 0,
    phase: siteSync.phase,
    waiting: draftAwaitingAutoSave,
  });

  if (configLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
        <div role="alert" className="space-y-2">
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">
            无法读取主题配置
          </div>
          <p className="max-w-[32rem] text-[13px] text-[var(--text-secondary)]">
            {configError instanceof Error ? configError.message : "请稍后重试。"}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void refetchConfig()}
            className="control-button px-4 py-2 text-[13px] font-medium"
          >
            重试
          </button>
          <Link to="/" className="control-button px-4 py-2 text-[13px] font-medium">
            返回首页
          </Link>
        </div>
      </div>
    );
  }

  const adminError = clientsError instanceof Error ? clientsError.message : null;
  const noTasksYet = !tasksLoading && !clientsLoading && sortedTasks.length === 0;
  const noFilteredTaskMatch = !tasksLoading && !clientsLoading && !noTasksYet && filteredTasks.length === 0;
  const setRatingLabelDraft = (kind: OverviewRatingKind, value: string) => {
    editVersionRef.current += 1;
    setDraft((prev) => ({
      ...prev,
      ratingLabels: { ...prev.ratingLabels, [kind]: value },
    }));
  };
  const acquiredAtMax = localDateInputMax();

  return (
    <div className="theme-manage flex flex-col gap-5 py-2">
      {/* 一行的粘性顶栏。原来是一整块 masthead（大标题 + 说明 + 统计），占掉小半屏、还跟着页面滚走，
          改设置时想看同步状态得先滚回顶上。 */}
      <header className="theme-topbar">
        <Link to="/" className="instance-page-back theme-topbar-back">
          <ArrowLeft size={14} />
          <span>返回首页</span>
        </Link>
        <h1 className="theme-topbar-title">主题设置</h1>
        <div className="theme-manage-toolbar-actions">
          {/* 两边都没有保存按钮了（停手就自动保存），「重置」退不回已经存下的改动，留着只会让人以为能撤销。
              填错了（不自动保存）把那一项改对即可。 */}
          {(!canSaveToSite || siteHasUnsyncedChanges) && (
            <button
              type="button"
              onClick={handleRestoreSiteDefaults}
              className="theme-manage-button"
              title={
                canSaveToSite
                  ? "放弃这台设备上还没同步到后端的改动（含配色、首页卡片上换过的线路），改用后端当前的配置"
                  : "放弃本机存过的设置（含配色、首页卡片上换过的线路），改用后端当前的配置（后台「外观设置 → 主题自定义配置」下发的那份）"
              }
            >
              <CloudDownload size={14} />
              <span>改用后端配置</span>
            </button>
          )}
          {!canSaveToSite && (
            <button
              type="button"
              onClick={() => void handleCopySiteDefaults()}
              className="theme-manage-button"
              title="复制当前设置的 JSON；粘贴到后台「外观设置 → 主题自定义配置」即可让所有设备用同一套配置"
            >
              {copied ? <ClipboardCheck size={14} /> : <ClipboardCopy size={14} />}
              <span>{copied ? "已复制" : "复制配置 JSON"}</span>
            </button>
          )}
          <SiteSyncIndicator
            phase={siteSync.phase}
            invalid={isDirty && (draftCostRateApiUrlInvalid || draftMultiPingInvalid)}
            // 表单停手等自动保存的那一小段也算「保存中」，不然会先闪一下「已保存」。
            waiting={draftAwaitingAutoSave}
            toSite={canSaveToSite}
            savedLocally={savedLocally}
          />
        </div>
      </header>


      {(message || error || adminError) && (
        <div className="flex flex-col gap-3">
          {message && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-[12px] border border-[color-mix(in_srgb,var(--status-online)_28%,transparent)] bg-[color-mix(in_srgb,var(--status-online)_11%,var(--surface))] px-4 py-3 text-[13px] text-[var(--status-online)]"
            >
              {message}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="rounded-[12px] border border-[color-mix(in_srgb,var(--status-offline)_28%,transparent)] bg-[color-mix(in_srgb,var(--status-offline)_11%,var(--surface))] px-4 py-3 text-[13px] text-[var(--status-offline)]"
            >
              {error}
            </div>
          )}
          {adminError && (
            <div
              role="alert"
              className="rounded-[12px] border border-[color-mix(in_srgb,var(--status-offline)_28%,transparent)] bg-[color-mix(in_srgb,var(--status-offline)_11%,var(--surface))] px-4 py-3 text-[13px] text-[var(--status-offline)]"
            >
              无法读取后台 Ping 任务或节点列表: {adminError}
            </div>
          )}
        </div>
      )}

      <div className="theme-manage-body" ref={bodyRef}>
        <nav className="theme-tab-rail" aria-label="设置分组">
          {THEME_TABS.map(({ id, label, hint, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => openTab(id)}
              data-active={activeTab === id ? "true" : "false"}
              aria-current={activeTab === id ? "page" : undefined}
              className="theme-tab"
            >
              <Icon size={14} className="theme-tab-icon" />
              <span className="theme-tab-label">{label}</span>
              <span className="theme-tab-hint">{hint}</span>
            </button>
          ))}
        </nav>

        <div className="theme-manage-sections" ref={sectionsRef}>
          {activeTab === "appearance" && (
            <>
              <InstancePanel
                id="set-appearance"
                kicker="外观"
                title="默认外观"
                aside={<LayoutTemplate size={16} />}
              >
                <div className="instance-segmented is-prominent is-even">
                  {APPEARANCE_OPTIONS.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      type="button"
                      data-active={draft.defaultAppearance === value ? "true" : "false"}
                      aria-pressed={draft.defaultAppearance === value}
                      onClick={() => patch("defaultAppearance", value)}
                      className="inline-flex items-center justify-center gap-2"
                    >
                      <Icon size={14} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </InstancePanel>

              <InstancePanel
                id="set-view"
                kicker="视图"
                title="默认卡片视图"
                aside={<LayoutGrid size={16} />}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="surface-inset setting-segment-slot flex flex-col gap-3 px-4 py-4">
                    <div>
                      <div className="setting-subhead-title">
                        桌面端默认
                      </div>
                      <div className="mt-1 setting-hint">
                        适用于宽度大于 720px 的浏览器窗口。
                      </div>
                    </div>
                    <div className="instance-segmented is-prominent is-even">
                      {NODE_VIEW_MODE_OPTIONS.map(({ value, label, icon: Icon }) => (
                        <button
                          key={value}
                          type="button"
                          data-active={draft.desktopNodeViewMode === value ? "true" : "false"}
                          aria-pressed={draft.desktopNodeViewMode === value}
                          onClick={() => patch("desktopNodeViewMode", value)}
                          className="inline-flex items-center justify-center gap-2"
                        >
                          <Icon size={14} />
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="surface-inset setting-segment-slot flex flex-col gap-3 px-4 py-4">
                    <div>
                      <div className="setting-subhead-title">
                        移动端默认
                      </div>
                      <div className="mt-1 setting-hint">
                        适用于宽度小于等于 720px 的手机或窄屏窗口。
                      </div>
                    </div>
                    <div className="instance-segmented is-prominent is-even">
                      {MOBILE_VIEW_MODE_OPTIONS.map(({ value, label, icon: Icon }) => (
                        <button
                          key={value}
                          type="button"
                          data-active={draft.mobileNodeViewMode === value ? "true" : "false"}
                          aria-pressed={draft.mobileNodeViewMode === value}
                          onClick={() => patch("mobileNodeViewMode", value)}
                          className="inline-flex items-center justify-center gap-2"
                        >
                          <Icon size={14} />
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </InstancePanel>

              <InstancePanel
                id="set-opacity"
                kicker="背景"
                title="卡片透明度"
                aside={<Wallpaper size={16} />}
              >
                <div className="flex flex-col gap-4">
                  <div className="surface-inset flex flex-col gap-3 px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="setting-subhead-title">
                        卡片不透明度
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          inputMode="numeric"
                          value={draft.surfaceOpacity}
                          onChange={(event) => {
                            // Number("") === 0,没有这行的话清空输入框(想重新输入)会把值跳成 0。
                            if (event.target.value.trim() === "") return;
                            const next = Number(event.target.value);
                            if (!Number.isFinite(next)) return;
                            patch("surfaceOpacity", Math.min(100, Math.max(0, Math.round(next))));
                          }}
                          aria-label="卡片不透明度百分比"
                          className="surface-inset w-20 px-3 py-2 text-right text-[13px] tabular outline-none"
                        />
                        <span className="text-[13px] font-medium text-[var(--text-tertiary)]">%</span>
                      </span>
                    </div>
                    <span className="setting-hint">
                      输入 0–100 的整数。100 = 完全不透明，数值越低卡片越通透、越能透出站点背景图。
                      低于 95 时会自动叠加一层可读性遮罩，保证文字清晰。
                    </span>
                  </div>
                  <div className="surface-inset px-4 py-3 setting-hint">
                    要更换背景图、站点标题或站点图标，请到 <code>/admin#admin</code> 的外观设置中修改，
                    它们对所有主题统一生效。
                  </div>
                </div>
              </InstancePanel>
            </>
          )}

          {activeTab === "home" && (
            <>
              <InstancePanel
                id="set-home-display"
                kicker="显示"
                title="首页显示项"
                aside={<ListFilter size={16} />}
              >
                <div className="grid gap-3 md:grid-cols-3">
                  <ToggleRow
                    field="showHomeOverview"
                    title="显示顶部总览"
                    desc="展示时间、在线数、地区、流量和速率。"
                    checked={draft.showHomeOverview}
                    onPatch={patch}
                  />
                  <ToggleRow
                    field="showAssetOverview"
                    title="显示资产概览"
                    desc="总览里那张写着每月花多少钱的卡片。不想把开销公开就关掉，其余总览卡不受影响。"
                    checked={draft.showAssetOverview}
                    onPatch={patch}
                  />
                  <ToggleRow
                    field="showGroupTabs"
                    title="显示分组筛选"
                    desc="根据后端节点分组生成首页 Tab。"
                    checked={draft.showGroupTabs}
                    onPatch={patch}
                  />
                  <ToggleRow
                    field="showRegionBar"
                    title="显示地区筛选"
                    desc="按节点地区生成国旗筛选栏，点击某地区只看该地区节点。"
                    checked={draft.showRegionBar}
                    onPatch={patch}
                  />
                  <ToggleRow
                    field="showCardGroup"
                    title="卡片显示分组"
                    desc="关闭后卡片内不再显示节点分组名（不影响分组筛选栏与备注）。"
                    checked={draft.showCardGroup}
                    onPatch={patch}
                  />
                  <ToggleRow
                    field="showCardPrice"
                    title="卡片显示价格"
                    desc="关闭后大卡片内不再显示价格。"
                    checked={draft.showCardPrice}
                    onPatch={patch}
                  />
                </div>

              </InstancePanel>

              <InstancePanel
                id="set-home-sort"
                kicker="排序"
                title="排序与分组"
                aside={<ArrowUpDown size={16} />}
              >
                {/* 开关和它决定的默认顺序放一起：拆开之后「关掉开关这两组还能不能设」就看不出来了。 */}
                <ToggleRow
                  field="enableHomeSort"
                  title="启用排序切换"
                  desc="首页显示排序控件，访客可临时切换排序方式（离线节点恒定置底）。关掉后所有人都按下面定的顺序看。"
                  checked={draft.enableHomeSort}
                  onPatch={patch}
                />

                {/* 四个字段一套网格：标题在上、控件撑满格子。宽窄不一、说明乱飘是上一版「看着乱」的来源。 */}
                <div className="setting-grid is-triple mt-4">
                  <div className="is-wide setting-segment-slot">
                    <div className="setting-subhead">
                      <span className="setting-subhead-title">默认排序维度</span>
                    </div>
                    <div className="instance-segmented is-prominent is-even">
                      {HOME_SORT_FIELDS.map((field) => (
                        <button
                          key={field}
                          type="button"
                          data-active={draft.homeSortField === field ? "true" : "false"}
                          aria-pressed={draft.homeSortField === field}
                          onClick={() => patch("homeSortField", field)}
                        >
                          {HOME_SORT_FIELD_LABELS[field]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="setting-subhead">
                      <span className="setting-subhead-title">默认方向</span>
                    </div>
                    <div className="instance-segmented is-prominent is-even">
                      <button
                        type="button"
                        data-active={draft.homeSortDirection === "asc" ? "true" : "false"}
                        aria-pressed={draft.homeSortDirection === "asc"}
                        onClick={() => patch("homeSortDirection", "asc")}
                      >
                        升序
                      </button>
                      <button
                        type="button"
                        data-active={draft.homeSortDirection === "desc" ? "true" : "false"}
                        aria-pressed={draft.homeSortDirection === "desc"}
                        onClick={() => patch("homeSortDirection", "desc")}
                      >
                        降序
                      </button>
                    </div>
                  </div>
                  <div>
                    <div className="setting-subhead">
                      <span className="setting-subhead-title">离线节点</span>
                    </div>
                    <div className="instance-segmented is-prominent is-even" role="group" aria-label="离线节点位置">
                      <button
                        type="button"
                        data-active={!draft.offlineNodesFirst ? "true" : "false"}
                        aria-pressed={!draft.offlineNodesFirst}
                        onClick={() => patch("offlineNodesFirst", false)}
                      >
                        排在最后
                      </button>
                      <button
                        type="button"
                        data-active={draft.offlineNodesFirst ? "true" : "false"}
                        aria-pressed={draft.offlineNodesFirst}
                        onClick={() => patch("offlineNodesFirst", true)}
                      >
                        排在最前
                      </button>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="setting-subhead">
                      <span className="setting-subhead-title">默认分组</span>
                    </div>
                    <SettingSelect
                      value={draft.homeDefaultGroup}
                      onChange={(event) => patch("homeDefaultGroup", event.target.value)}
                      aria-label="默认分组"
                    >
                      <option value="">全部（不指定）</option>
                      {/* 站点换过分组名时，存着的那个值仍列出来，免得选中项凭空消失。 */}
                      {draft.homeDefaultGroup !== "" &&
                        !availableGroups.includes(draft.homeDefaultGroup) && (
                          <option value={draft.homeDefaultGroup}>
                            {draft.homeDefaultGroup}（当前没有这个分组）
                          </option>
                        )}
                      {availableGroups.map((group) => (
                        <option key={group} value={group}>
                          {group}
                        </option>
                      ))}
                    </SettingSelect>
                  </div>
                </div>

                <p className="mt-3 setting-hint">
                  以上是访客首次打开首页时看到的顺序与分组；访客临时改过的排序只在他自己的标签页里有效。
                </p>

                <div className="mt-4">
                  <div className="setting-subhead">
                    <span className="setting-subhead-title">分组排序</span>
                    <span className="setting-hint">
                      调整首页分组 Tab 的显示顺序；未列出的分组按后端顺序排在后面。
                    </span>
                  </div>
                  {orderedDraftGroups.length === 0 ? (
                    <p className="surface-inset mt-2 px-4 py-3 text-[12px] text-[var(--text-tertiary)]">
                      {clientsLoading ? "正在加载分组…" : "暂无分组（节点未设置分组时无需排序）"}
                    </p>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-2">
                      {orderedDraftGroups.map((group, index) => (
                        <li
                          key={group}
                          className="surface-inset flex items-center justify-between gap-3 px-4 py-2.5"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="tabular text-[12px] text-[var(--text-tertiary)]">
                              {index + 1}
                            </span>
                            <span
                              className="truncate text-[13px] text-[var(--text-primary)]"
                              title={group}
                            >
                              {group}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              disabled={index === 0}
                              onClick={() => moveGroup(index, -1)}
                              className="theme-manage-button is-compact"
                              aria-label={`上移 ${group}`}
                            >
                              <ChevronUp size={14} />
                            </button>
                            <button
                              type="button"
                              disabled={index === orderedDraftGroups.length - 1}
                              onClick={() => moveGroup(index, 1)}
                              className="theme-manage-button is-compact"
                              aria-label={`下移 ${group}`}
                            >
                              <ChevronDown size={14} />
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 地区顺序在首页地区栏上直接拖（站长提的：拖比在这里上下点直观）；这里只留查看和恢复默认。 */}
                <div className="mt-4">
                  <div className="setting-subhead">
                    <span className="setting-subhead-title">地区排序</span>
                    <span className="setting-hint">
                      在首页按住地区标签直接拖动（手机上先长按）；新出现的地区按默认规则排在后面。
                    </span>
                  </div>
                  <div className="surface-inset mt-2 flex items-center justify-between gap-3 px-4 py-2.5">
                    <span
                      className="truncate text-[13px] text-[var(--text-primary)]"
                      title={draft.homeRegionOrder.join(" → ")}
                    >
                      {draft.homeRegionOrder.length > 0
                        ? draft.homeRegionOrder.join(" → ")
                        : "默认：中国大陆、港澳台、新加坡、日本、美国、欧洲、其他"}
                    </span>
                    <button
                      type="button"
                      disabled={draft.homeRegionOrder.length === 0}
                      onClick={() => patch("homeRegionOrder", [])}
                      className="theme-manage-button is-compact shrink-0"
                    >
                      恢复默认
                    </button>
                  </div>
                </div>

              </InstancePanel>

              <InstancePanel
                id="set-home-ratings"
                kicker="评级"
                title="总览评级"
                aside={<Sparkles size={16} />}
              >
                <div className="surface-inset px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block setting-subhead-title">
                        三处总览
                      </span>
                      <span className="mt-1 block setting-hint">
                        关掉这里，三处评级一起不显示。
                      </span>
                    </span>
                    <label className="inline-flex shrink-0 items-center gap-2 setting-field-label">
                      <span>启用</span>
                      <input
                        type="checkbox"
                        checked={draft.showOverviewRatings}
                        onChange={(event) => patch("showOverviewRatings", event.target.checked)}
                        className="h-4 w-4 accent-[var(--accent-500)]"
                      />
                    </label>
                  </div>

                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    {OVERVIEW_RATING_LABEL_FIELDS.map((field) => {
                      const defaultLabel = getDefaultOverviewRatingLabelText(field.key);
                      const ratingEnabled = draft.showOverviewRatings && draft[field.toggleKey];
                      return (
                        <div key={field.key} className="flex min-w-0 flex-col gap-2">
                          <label className="flex items-center justify-between gap-2 setting-field-label">
                            <span>{field.title}</span>
                            <input
                              type="checkbox"
                              checked={draft[field.toggleKey]}
                              disabled={!draft.showOverviewRatings}
                              onChange={(event) => patch(field.toggleKey, event.target.checked)}
                              className="h-4 w-4 shrink-0 accent-[var(--accent-500)]"
                            />
                          </label>
                          <input
                            value={draft.ratingLabels[field.key]}
                            disabled={!ratingEnabled}
                            onChange={(event) => setRatingLabelDraft(field.key, event.target.value)}
                            placeholder={defaultLabel}
                            aria-label={`${field.title}评级名称`}
                            className="surface-inset w-full px-3 py-2 text-[13px] outline-none disabled:opacity-60"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </InstancePanel>

              <InstancePanel
                id="set-hidden"
                kicker="隐藏"
                title="隐藏节点"
                aside={<EyeOff size={16} />}
              >
                <label className="flex min-w-0 flex-col gap-2">
                  <span className="setting-field-label">
                    隐藏列表
                  </span>
                  <textarea
                    value={draft.hiddenNodesText}
                    onChange={(event) => patch("hiddenNodesText", event.target.value)}
                    placeholder="每行一个节点名称 / UUID，也可以用逗号分隔"
                    className="surface-inset min-h-[112px] w-full resize-y px-3 py-2 text-[13px] outline-none"
                  />
                  <span className="setting-hint">
                    已隐藏 {draftHiddenNodes.length} 个节点。按名称或 UUID 匹配、大小写不敏感；隐藏的节点
                    不显示卡片，也不计入在线数、流量、带宽与资产等任何统计，清空即恢复。
                  </span>
                </label>
              </InstancePanel>
            </>
          )}

          {activeTab === "card" && (
            <>
              <InstancePanel
                id="set-card"
                kicker="卡片"
                title="卡片显示项"
                aside={<Rows3 size={16} />}
              >
                <div>
                  <div className="setting-subhead">
                    <span className="setting-subhead-title">跨视图设置</span>
                    <span className="setting-hint">
                      适用于多个卡片尺寸，具体范围以每项说明为准。
                    </span>
                  </div>
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <ToggleRow
                      field="showConnections"
                      title="显示连接数（TCP/UDP）"
                      desc="在大卡片与小卡片展示实时 TCP / UDP 连接数；需被控端上报，未上报显示 0。默认关闭。"
                      checked={draft.showConnections}
                      onPatch={patch}
                    />
                  </div>
                </div>

                <div className="mt-4">
                  <div className="setting-subhead">
                    <span className="setting-subhead-title">小卡片专属</span>
                    <span className="setting-hint">
                      控制小卡片中间信息块的密度；实时速率始终显示。
                    </span>
                  </div>
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <ToggleRow
                      field="compactShowTrafficTotal"
                      title="显示累计流量"
                      desc="展示出站与入站累计流量。"
                      checked={draft.compactShowTrafficTotal}
                      onPatch={patch}
                    />
                    <ToggleRow
                      field="compactShowBilling"
                      title="显示费用到期"
                      desc="展示续费价格与剩余天数。"
                      checked={draft.compactShowBilling}
                      onPatch={patch}
                    />
                    <ToggleRow
                      field="compactShowUptime"
                      title="显示在线时间"
                      desc="在小卡片流量栏右侧展示在线时长。默认开启。"
                      checked={draft.compactShowUptime}
                      onPatch={patch}
                    />
                  </div>
                </div>
              </InstancePanel>
            </>
          )}

          {activeTab === "cost" && (
            <>
              <InstancePanel
                id="set-cost"
                kicker="花费"
                title="服务器花费"
                aside={<CircleDollarSign size={16} />}
              >
                {/* 和「排序与分组」同一套：开关整行在上，字段两列、标题在上，说明收到最下面一行。 */}
                <ToggleRow
                  field="showCostSummary"
                  title="显示资产统计入口"
                  desc="资产概览卡在就放卡内，不在就悬浮在右下角。关掉后访问资产页会跳回首页。"
                  checked={draft.showCostSummary}
                  onPatch={patch}
                />

                <div className="setting-grid mt-4">
                  <div className="min-w-0">
                    <div className="setting-subhead">
                      <span className="setting-subhead-title">续费提醒</span>
                    </div>
                    <label className="surface-inset setting-control flex items-center gap-2 px-3">
                      <span className="shrink-0 text-[13px] text-[var(--text-secondary)]">到期前</span>
                      <input
                        type="number"
                        min={0}
                        max={MAX_RENEWAL_REMINDER_DAYS}
                        step={1}
                        inputMode="numeric"
                        value={draft.renewalReminderDays}
                        onChange={(event) => {
                          if (event.target.value.trim() === "") return;
                          const next = Number(event.target.value);
                          if (!Number.isFinite(next)) return;
                          patch(
                            "renewalReminderDays",
                            Math.min(MAX_RENEWAL_REMINDER_DAYS, Math.max(0, Math.round(next))),
                          );
                        }}
                        aria-label="续费提醒天数"
                        className="min-w-0 flex-1 bg-transparent py-2 text-right text-[13px] tabular text-[var(--text-primary)] outline-none"
                      />
                      <span className="shrink-0 text-[13px] text-[var(--text-secondary)]">天</span>
                    </label>
                  </div>
                  <div className="min-w-0">
                    <div className="setting-subhead">
                      <span className="setting-subhead-title">实时汇率接口</span>
                    </div>
                    <input
                      value={draft.costRateApiUrl}
                      onChange={(event) => patch("costRateApiUrl", event.target.value)}
                      placeholder={DEFAULT_THEME_SETTINGS.costRateApiUrl}
                      aria-invalid={draftCostRateApiUrlInvalid}
                      aria-label="实时汇率接口"
                      className="surface-inset setting-control px-3 py-2 text-[13px] outline-none"
                    />
                    {draftCostRateApiUrlInvalid && (
                      <span className="mt-2 block text-[12px] text-[var(--status-offline)]">
                        请输入 http(s) 链接，保存后将回退默认接口
                      </span>
                    )}
                  </div>
                  <div className="is-wide min-w-0">
                    <div className="setting-subhead">
                      <span className="setting-subhead-title">忽略计费节点</span>
                    </div>
                    <textarea
                      value={draft.costIgnoredText}
                      onChange={(event) => patch("costIgnoredText", event.target.value)}
                      placeholder="每行一个节点名称 / UUID，也可以用逗号分隔"
                      aria-label="忽略计费节点"
                      className="surface-inset setting-control block min-h-[88px] resize-y px-3 py-2 text-[13px] outline-none"
                    />
                  </div>
                </div>

                <p className="mt-3 setting-hint">
                  续费提醒显示在资产概览卡上，填 0 就不提醒；汇率接口留空用默认；忽略的节点不计入资产统计。
                </p>
              </InstancePanel>

              <InstancePanel
                id="set-premium"
                kicker="溢价"
                title="收购溢价"
                aside={<Coins size={16} />}
              >
                <div className="flex flex-col gap-3">
                    <p className="setting-hint">
                      按收购日的剩余价值回算并固化溢价（收购价 − 当日剩余价值，可正可负），之后续费与汇率
                      变化都不改写；改收购日期会重算，留空即清除记录。已设置 {premiumConfiguredCount} 个节点。
                    </p>
                    <label className="surface-inset flex items-center gap-2 px-3 py-2">
                      <Search size={14} className="text-[var(--text-tertiary)]" />
                      <input
                        value={premiumSearch}
                        onChange={(event) => setPremiumSearch(event.target.value)}
                        placeholder="搜索节点名称 / UUID / 分组 / 地区"
                        aria-label="搜索节点"
                        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-tertiary)]"
                      />
                    </label>

                    {clientsLoading && (
                      <div className="flex min-h-[15vh] items-center justify-center">
                        <Spinner size={24} />
                      </div>
                    )}

                    {!clientsLoading && sortedClients.length === 0 && (
                      <div className="theme-manage-empty-state">
                        <span>还没有任何节点。</span>
                      </div>
                    )}

                    {!clientsLoading && sortedClients.length > 0 && filteredPremiumClients.length === 0 && (
                      <div className="surface-inset px-4 py-5 text-[13px] text-[var(--text-secondary)]">
                        没有匹配的节点。
                      </div>
                    )}

                    {!clientsLoading && filteredPremiumClients.length > 0 && (
                      <PremiumList
                        clients={filteredPremiumClients}
                        costPremiums={draft.costPremiums}
                        detailByUuid={premiumDetailByUuid}
                        rateLoading={premiumRateQuery.isLoading}
                        acquiredAtMax={acquiredAtMax}
                        onPatchPaid={patchPremiumPaid}
                        onPatchAcquiredAt={patchPremiumAcquiredAt}
                      />
                    )}
                </div>
              </InstancePanel>
            </>
          )}

          {activeTab === "ping" && (
            <>
              <InstancePanel
                id="set-ping"
                kicker="线路"
                title="主页延迟检测"
                aside={<Activity size={16} />}
              >
                <div className="flex flex-col gap-4">
                  {/* 大卡片 / 小卡片显示哪种：单线路还是多线路。原来是个复选框，和下面的单线路设置
                      混在一排，看不出「哪些设置属于哪种模式」—— 换成分段切换，选中哪种就只展开哪种的设置。 */}
                  <div className="surface-inset px-4 py-4">
                    <div className="min-w-0">
                      <span className="block setting-subhead-title">
                        大卡片 / 小卡片显示
                      </span>
                      <span className="mt-1 block setting-hint">
                        迷你卡片与列表放不下多行，始终按单线路显示，不受这里影响。探测线路由后端固定，
                        共 {sortedTasks.length} 条；没配探测目标的线路没有数据。
                      </span>
                    </div>
                    {/* 整行、等宽、强调色实心：这是本板块的总开关，得一眼看出选中的是哪种。 */}
                    <div className="instance-segmented is-prominent mt-3">
                      {HOMEPAGE_PING_MODE_OPTIONS.map(({ value, label, icon: Icon }) => {
                        const active = draft.enableHomepageMultiPing === value;
                        return (
                          <button
                            key={label}
                            type="button"
                            data-active={active ? "true" : "false"}
                            aria-pressed={active}
                            disabled={
                              value && !tasksLoading && sortedTasks.length < HOMEPAGE_MULTI_PING_MIN_COUNT
                            }
                            onClick={() => patch("enableHomepageMultiPing", value)}
                            className="inline-flex items-center justify-center gap-2"
                          >
                            <Icon size={15} />
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>

                    {draft.enableHomepageMultiPing ? (
                      <div className="mt-4 border-t border-[var(--hairline)] pt-4">
                        <div className="setting-subhead">
                          <span className="setting-field-label">
                            显示这些线路（按顺序）
                          </span>
                          <span className="setting-hint">
                            已选 {draft.homepageMultiPingTaskIds.length} / {multiPingSlotLimit} 条
                          </span>
                        </div>
                        {/* 槽位数量跟着已选条数走。「移除」是紧挨着下拉框的小 × ——
                            放在标签行右端时会紧贴下一列的标签，看着像是下一条线路的按钮。 */}
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          {draft.homepageMultiPingTaskIds.map((selectedTaskId, slot) => (
                            // key 用槽位号、不带线路 id：互换会同时改两个槽位，带 id 的话两个都重新挂载，
                            // 刚操作的下拉框丢焦点，键盘上下切线路切一下就断。
                            <div key={slot} className="min-w-0">
                              <label
                                htmlFor={`multi-ping-slot-${slot}`}
                                className="mb-1.5 block setting-field-label"
                              >
                                线路 {slot + 1}
                              </label>
                              <div className="flex items-center gap-1.5">
                                <SettingSelect
                                  id={`multi-ping-slot-${slot}`}
                                  value={selectedTaskId}
                                  onChange={(event) =>
                                    patchMultiPingTask(slot, event.target.value)
                                  }
                                  wrapperClassName="flex-1"
                                >
                                  {!sortedTasks.some((task) => task.id === selectedTaskId) && (
                                    <option value={selectedTaskId}>
                                      任务 #{selectedTaskId}（当前不可用）
                                    </option>
                                  )}
                                  {sortedTasks.map((task) => {
                                    const usedAt = draft.homepageMultiPingTaskIds.indexOf(task.id);
                                    const swapsWith = task.id !== selectedTaskId ? usedAt : -1;
                                    return (
                                      <option key={task.id} value={task.id}>
                                        {`${task.name || `任务 #${task.id}`}${
                                          swapsWith >= 0 ? `（与线路 ${swapsWith + 1} 互换）` : ""
                                        }`}
                                      </option>
                                    );
                                  })}
                                </SettingSelect>
                                <button
                                  type="button"
                                  onClick={() => removeMultiPingTask(slot)}
                                  disabled={
                                    draft.homepageMultiPingTaskIds.length <=
                                    HOMEPAGE_MULTI_PING_MIN_COUNT
                                  }
                                  aria-label={`移除线路 ${slot + 1}`}
                                  title="移除这条线路"
                                  className="surface-inset flex h-[38px] w-[38px] shrink-0 items-center justify-center text-[var(--text-tertiary)] transition-colors hover:border-[var(--status-error)] hover:text-[var(--status-error)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-[var(--hairline)] disabled:hover:text-[var(--text-tertiary)]"
                                >
                                  <X size={14} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          {/* 用设置页统一的小按钮：原来写的 px-3 py-1.5 text-[12px] 这类 Tailwind 类在 <button> 上
                              不生效（index.css 里没进 layer 的 button 重置压过工具类），字号成了 16px、内边距 0，字顶着边框。 */}
                          <button
                            type="button"
                            onClick={addMultiPingTask}
                            disabled={
                              draft.homepageMultiPingTaskIds.length >= multiPingSlotLimit
                            }
                            className="theme-manage-button is-compact"
                          >
                            <Plus size={13} />
                            添加线路
                          </button>
                          <span
                            className={clsx(
                              "text-[11px] leading-relaxed",
                              draftMultiPingInvalid
                                ? "text-[var(--status-error)]"
                                : "text-[var(--text-tertiary)]",
                            )}
                            role={draftMultiPingInvalid ? "alert" : undefined}
                          >
                            {draftMultiPingInvalid
                              ? "至少选 1 条线路后再保存，否则会回退到单线路模式。"
                              : "某条线路没有节点样本时保留该行并显示“无样本”。"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-4 border-t border-[var(--hairline)] pt-4 setting-hint">
                        每台节点只显示一条线路，用下面「单线路设置」里的默认线路；个别节点想看别的线路，
                        用下面的「逐节点指定线路」。
                      </p>
                    )}
                  </div>

                  {/* 单线路设置不能删：迷你卡片与列表永远走单线路，这里是它们唯一的设置入口。 */}
                  <div className="surface-inset px-4 py-4">
                    <div className="min-w-0">
                      <span className="block setting-subhead-title">
                        单线路设置
                      </span>
                      <span className="mt-1 block setting-hint">
                        {draft.enableHomepageMultiPing
                          ? "大/小卡片当前走多线路，用不到这组；迷你卡片与列表仍按单线路显示。"
                          : "作用于所有视图。"}
                      </span>
                    </div>

                    {/* 默认线路：原来是标题行右端一个窄下拉，混在一堆文字里看不见。挪到正文、
                        用和模式切换同一套整行分段控件，选中项强调色实心。 */}
                    <div className="mt-4 border-t border-[var(--hairline)] pt-4">
                          <div className="setting-subhead">
                            <span className="setting-field-label">
                              默认线路
                            </span>
                            <span className="setting-hint">
                              没单独指定的节点都走这条
                            </span>
                          </div>
                          <div className="instance-segmented is-prominent" role="group" aria-label="默认线路">
                            {!sortedTasks.some(
                              (task) => task.id === draft.homepageDefaultPingTaskId,
                            ) && (
                              <button
                                type="button"
                                data-active="true"
                                aria-pressed
                                disabled
                                className="inline-flex items-center justify-center"
                              >
                                任务 #{draft.homepageDefaultPingTaskId}（当前不可用）
                              </button>
                            )}
                            {sortedTasks.map((task) => {
                              const active = task.id === draft.homepageDefaultPingTaskId;
                              return (
                                <button
                                  key={task.id}
                                  type="button"
                                  data-active={active ? "true" : "false"}
                                  aria-pressed={active}
                                  onClick={() => patch("homepageDefaultPingTaskId", task.id)}
                                  className="inline-flex items-center justify-center"
                                >
                                  {task.name || `任务 #${task.id}`}
                                </button>
                              );
                            })}
                          </div>
                          <p className="mt-2 setting-hint">
                            新加的节点也自动跟着它，不用回来一台台绑；个别节点想看别的线路，用下面的「逐节点指定线路」。
                          </p>
                        </div>
                  </div>
                </div>
              </InstancePanel>

              <InstancePanel
                id="set-ping-bindings"
                kicker="绑定"
                title="逐节点指定线路"
                aside={<Network size={16} />}
              >
                <div className="flex flex-col gap-3">
                  <p className="setting-hint">
                    没指定的节点都走上面的默认线路；迷你卡片与列表始终按单线路显示，这里指定的对它们同样生效。
                    已单独指定 {assignedNodeCount} / {sortedClients.length} 台。
                  </p>
                  <label className="surface-inset mb-3 flex items-center gap-2 px-3 py-2">
                    <Search size={14} className="text-[var(--text-tertiary)]" />
                    <input
                      value={taskSearch}
                      onChange={(event) => setTaskSearch(event.target.value)}
                      placeholder="搜索线路名称"
                      aria-label="搜索线路"
                      className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-tertiary)]"
                    />
                  </label>

                  <div className="flex flex-col gap-3">
                    {(tasksLoading || clientsLoading) && (
                      <div className="flex min-h-[20vh] items-center justify-center">
                        <Spinner size={24} />
                      </div>
                    )}

                    {noTasksYet && (
                      <div className="theme-manage-empty-state">
                        <span>没有可用的探测线路。</span>
                      </div>
                    )}

                    {noFilteredTaskMatch && (
                      <div className="px-1 py-3 text-[13px] text-[var(--text-secondary)]">
                        没有匹配的线路。
                      </div>
                    )}

                    {!tasksLoading &&
                      !clientsLoading &&
                      !noTasksYet &&
                      filteredTasks.map((task) => {
                        const expanded = expandedTaskId === task.id;
                        return (
                          <TaskBindingSection
                            key={task.id}
                            task={task}
                            defaultTaskId={draft.homepageDefaultPingTaskId}
                            assigned={
                              draft.homepagePingBindings[String(task.id)] ??
                              EMPTY_ASSIGNED_CLIENTS
                            }
                            expanded={expanded}
                            clientsById={clientsById}
                            // 收起的卡片收到稳定空值:节点搜索的每次击键只重渲展开的那一张。
                            visibleClients={expanded ? visibleClients : EMPTY_ADMIN_CLIENTS}
                            assignedTaskByClientUuid={assignedTaskByClientUuid}
                            nodeSearch={expanded ? nodeSearch : ""}
                            onNodeSearch={setNodeSearch}
                            onToggleExpand={toggleTaskExpanded}
                            onPatchBindings={patchBindings}
                          />
                        );
                      })}
                  </div>

                </div>
              </InstancePanel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
