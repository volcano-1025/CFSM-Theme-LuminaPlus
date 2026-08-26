import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardCopy,
  CloudDownload,
  CloudUpload,
  EyeOff,
  Grid3x3,
  LayoutTemplate,
  LayoutGrid,
  List,
  ListFilter,
  Moon,
  RefreshCw,
  Rows3,
  Save,
  Search,
  Sun,
  SunMoon,
  Wallpaper,
} from "lucide-react";
import { clsx } from "clsx";
import { InstancePanel } from "@/components/instance/InstancePanel";
import { Spinner } from "@/components/ui/Spinner";
import { Flag } from "@/components/ui/Flag";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { useHourlyClock } from "@/hooks/useClock";
import { pickPaletteSettings } from "@/hooks/useMetricColors";
import { useLocalThemeSettings } from "@/hooks/useThemeSettings";
import { getNodes, saveThemeOptions } from "@/services/api";
import { getJwtToken } from "@/services/cfsm/config";
import { ApiRequestError } from "@/services/cfsm/http";
import { carrierPingTasks } from "@/services/cfsm/mappers";
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
import {
  dedupeGroupLabels,
  normalizeHomeGroupOrder,
  sortHomeGroupOptions,
} from "@/utils/homeNodes";
import {
  DEFAULT_HOMEPAGE_PING_TASK_ID,
  HOMEPAGE_MULTI_PING_TASK_COUNT,
  normalizeHomepageMultiPingTaskIds,
  normalizeHomepagePingTaskBindings,
  type HomepagePingTaskBindings,
} from "@/utils/pingTasks";
import {
  DEFAULT_THEME_SETTINGS,
  normalizeThemeSettings,
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
    enableHomepageMultiPing: settings.enableHomepageMultiPing,
    homepageMultiPingTaskIds: settings.homepageMultiPingTaskIds,
    fakePingForUnbound: settings.fakePingForUnbound,
    showHomeOverview: settings.showHomeOverview,
    showGroupTabs: settings.showGroupTabs,
    showRegionBar: settings.showRegionBar,
    showCardGroup: settings.showCardGroup,
    showCardPrice: settings.showCardPrice,
    homeGroupOrder: settings.homeGroupOrder,
    enableHomeSort: settings.enableHomeSort,
    homeSortField: settings.homeSortField,
    homeSortDirection: settings.homeSortDirection,
    showCostSummary: settings.showCostSummary,
    showCostSummaryFloatingButton: settings.showCostSummaryFloatingButton,
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
function draftFromSettings(settings: ResolvedThemeSettings): ThemeDraft {
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
        <span className="block text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
        <span className="mt-1 block text-[11px] text-[var(--text-tertiary)]">{desc}</span>
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

const EMPTY_ASSIGNED_CLIENTS: string[] = [];
const EMPTY_ADMIN_CLIENTS: NodeInfo[] = [];

// 单个 Ping 任务的绑定卡片。memo:编辑无关设置的击键不再重渲任务列表;展开态的
// tasks×clients 复选网格只在绑定/搜索/展开变化时重算。
const TaskBindingSection = memo(function TaskBindingSection({
  task,
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
  const assignedSummary = summarizeNodes(assigned, clientsById);
  // 探测点是后端固定的四条线路，没绑定的节点会落到默认线路（电信），这里标出来免得站长
  // 以为「0 个节点」就是没人用它。
  const isDefaultTask = task.id === DEFAULT_HOMEPAGE_PING_TASK_ID;
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
              {assigned.length > 0
                ? `${assigned.length} 台节点在首页显示这条线路的延迟`
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
          {assigned.length > 0 && (
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
                      <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {client.name}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">
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
                className="shrink-0 text-[11px] text-[var(--text-tertiary)]"
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

export function ThemeManage() {
  const now = useHourlyClock();
  const {
    data: config,
    isLoading: configLoading,
    error: configError,
    refetch: refetchConfig,
  } = usePublicConfig();
  // 全部托管设置收敛为单个草稿对象。之前是 30 个平行 useState,每新增一项设置要同步维护
  // 声明/seedDrafts/payload/依赖数组四处清单;现在键清单只在 pickManagedThemeSettings 一处。
  const [draft, setDraft] = useState<ThemeDraft>(() =>
    draftFromSettings(DEFAULT_THEME_SETTINGS),
  );
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null);
  const [taskSearch, setTaskSearch] = useState("");
  const [nodeSearch, setNodeSearch] = useState("");
  const [premiumSearch, setPremiumSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingSite, setSavingSite] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 「保存到站点」只对登录站长开放：有 jwt_token 才显示。令牌陈旧则写请求会 401，另行提示。
  const canSaveToSite = useMemo(() => Boolean(getJwtToken()), []);
  const savingDraftRef = useRef<ThemeDraft | null>(null);
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
  const toggleTaskExpanded = useCallback((taskId: number) => {
    setExpandedTaskId((current) => (current === taskId ? null : taskId));
    setNodeSearch("");
  }, []);
  const patchMultiPingTask = useCallback((slot: number, rawValue: string) => {
    editVersionRef.current += 1;
    setDraft((prev) => {
      const nextIds = [...prev.homepageMultiPingTaskIds];
      if (rawValue === "") {
        nextIds.splice(slot, 1);
      } else {
        nextIds[slot] = Number(rawValue);
      }
      const homepageMultiPingTaskIds = normalizeHomepageMultiPingTaskIds(nextIds);
      return JSON.stringify(homepageMultiPingTaskIds) ===
        JSON.stringify(prev.homepageMultiPingTaskIds)
        ? prev
        : { ...prev, homepageMultiPingTaskIds };
    });
  }, []);

  // CF-Server-Monitor 的探测点固定为四条线路，没有可配置的 ping 任务列表。
  const pingTasks = useMemo(() => carrierPingTasks(), []);
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
  const sourceThemeSettings = useMemo(
    () =>
      normalizeThemeSettings({
        ...(config?.theme_settings ?? {}),
        ...localThemeSettings,
      }),
    [config?.theme_settings, localThemeSettings],
  );
  // 按内容判断服务端设置是否真的变化，避免同内容 refetch 重置草稿。
  const sourceSignature = useMemo(
    () => JSON.stringify(pickManagedThemeSettings(sourceThemeSettings)),
    [sourceThemeSettings],
  );
  const lastSeededSignatureRef = useRef<string | null>(null);

  // 把服务端设置灌入草稿的唯一出口,reseed effect 和重置按钮都走它,避免两边逻辑漂移。
  const seedDrafts = useCallback((next: ResolvedThemeSettings) => {
    setDraft(draftFromSettings(next));
  }, []);

  const sortedTasks = useMemo(() => sortTasks(pingTasks), [pingTasks]);
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
    draft.homepageMultiPingTaskIds.length !== HOMEPAGE_MULTI_PING_TASK_COUNT;

  // 由当前草稿拼出的设置 payload,保存请求和 dirty 判断都用它。草稿字段与设置同名,这里只做
  // 「编辑态 → 存储态」的换形与归一化;文本域(hiddenNodesText/costIgnoredText)和 ratingLabels
  // 解构出来换回存储字段,其余原样透传。
  const draftThemeSettings = useMemo<ThemeSettings>(() => {
    const { ratingLabels, hiddenNodesText, costIgnoredText, ...rest } = draft;
    return {
      ...rest,
      homepagePingBindings: pruneBindings(rest.homepagePingBindings),
      homeGroupOrder: normalizeHomeGroupOrder(rest.homeGroupOrder),
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

  // 服务端设置真正变化时灌入草稿。首次灌入之后,只要表单有未保存编辑(含保存中)就跳过,
  // 避免 refetch / 其他端保存的回流静默覆盖用户草稿。
  useEffect(() => {
    if (!config) return;
    if (lastSeededSignatureRef.current === sourceSignature) return;
    if (lastSeededSignatureRef.current !== null && isDirty) return;
    lastSeededSignatureRef.current = sourceSignature;
    seedDrafts(sourceThemeSettings);
  }, [config, isDirty, sourceSignature, sourceThemeSettings, seedDrafts]);

  const assignedNodeCount = useMemo(
    () =>
      Object.values(draft.homepagePingBindings).reduce(
        (total, clients) => total + clients.length,
        0,
      ),
    [draft.homepagePingBindings],
  );

  // 每个 client 归属哪个 task 的反查,只在绑定草稿变化时重建。与「全选可用」reducer
  // 共用 invertBindings() 避免推导漂移,并把可选节点过滤保持在 O(tasks × clients),
  // 而不是每个 client 都重扫一遍 bindings。
  const assignedTaskByClientUuid = useMemo(
    () => invertBindings(draft.homepagePingBindings),
    [draft.homepagePingBindings],
  );

  const handleSave = async () => {
    if (savingDraftRef.current || draftMultiPingInvalid) return;
    const submittedEditVersion = editVersionRef.current;
    savingDraftRef.current = draft;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      // 第三方主题不能写后端设置，这里只保存到浏览器本地；站点级预设仍由后台
      // 「主题自定义配置」的 theme_options 提供。
      // 合并进已有的本地设置：配色选择器写的 metricColors / darkDepth 不归本页管，
      // 整体覆盖会把它们一起抹掉。
      saveLocalThemeSettings({ ...getLocalThemeSettings(), ...draftThemeSettings });
      if (editVersionRef.current === submittedEditVersion) {
        setMessage("主题设置已保存到本机浏览器");
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      savingDraftRef.current = null;
      setSaving(false);
    }
  };

  /**
   * 当前设置导出成后台「主题自定义配置」能直接粘贴的 JSON。
   *
   * 第三方主题不能写后端设置，多设备同步只能走这条路：复制 → 粘进后台 → 所有设备（以及
   * 所有访客）都以它为默认值。导出的是完整快照，包含配色等本页之外的设置。
   */
  const siteDefaults = useMemo(() => {
    // 配色的口径和全站一致：站点预设打底，本机覆盖在上。normalizeThemeSettings 是白名单，
    // 认不得 metricColors / darkDepth，所以取色器调的配色要单独并回快照。
    const merged = {
      ...(config?.theme_settings ?? {}),
      ...localThemeSettings,
      ...draftThemeSettings,
    } as ThemeSettings & Record<string, unknown>;
    return {
      ...normalizeThemeSettings(merged),
      ...pickPaletteSettings(merged),
    } as Record<string, unknown>;
  }, [config?.theme_settings, localThemeSettings, draftThemeSettings]);

  // 「复制配置 JSON」（手动粘后台）与「保存到站点」（POST /api/theme_options）用的是同一份快照。
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
   * 一键把当前配置写到站点级（后端 `theme_options`），替代「复制 JSON → 手动粘到后台」。
   * 仅登录站长可用。成功后按用户选定的「自动同步」丢掉本机覆盖、用刚提交的快照重新播种草稿，
   * 让当前设备立刻以站点预设为准（不必等 config 查询回灌）。
   */
  const handleSaveToSite = async () => {
    setError(null);
    setMessage(null);
    setSavingSite(true);
    try {
      await saveThemeOptions(siteDefaults);
      resetLocalThemeSettings();
      seedDrafts(normalizeThemeSettings(siteDefaults));
      void refetchConfig(); // 让其它消费者（首页等）也拿到最新站点预设。
      setMessage("已保存到站点：所有设备与访客都会以这套配置为默认值");
    } catch (saveError) {
      if (saveError instanceof ApiRequestError && saveError.status === 401) {
        setError("登录态已失效，请到 /admin 重新登录后再保存到站点（本机设置不受影响）");
      } else if (saveError instanceof ApiRequestError && saveError.status === 403) {
        // http 层已清掉 Turnstile 凭证；刷新 config 让全局验证弹窗重新出现。
        void refetchConfig();
        setError("本站需要人机验证：完成弹出的验证后，再点一次「保存到站点」");
      } else if (saveError instanceof ApiRequestError && saveError.status === 400) {
        setError("配置格式被后端拒绝（invalidThemeOptionsFormat），请把这条信息反馈给作者");
      } else {
        setError(saveError instanceof Error ? saveError.message : "保存到站点失败");
      }
    } finally {
      setSavingSite(false);
    }
  };

  const handleReset = () => {
    seedDrafts(sourceThemeSettings);
    setMessage(null);
    setError(null);
  };

  /**
   * 清掉本地覆盖，回到后端 theme_options + 主题默认值。
   *
   * 对站长来说这就是「同步后台配置」：本机存过的设置只要还在，后台改的 JSON 就永远压不过来
   * （合并规则是本地覆盖优先），必须先把本地那份丢掉。
   */
  const handleRestoreSiteDefaults = () => {
    resetLocalThemeSettings();
    // 表单同步回站点默认值：否则会留下一份"已被清除但仍显示"的脏草稿。
    seedDrafts(normalizeThemeSettings(config?.theme_settings));
    setMessage("已丢弃本机设置，改用后台最新的配置 JSON");
    setError(null);
  };

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
      <header className="theme-masthead">
        <div className="theme-masthead-topline">
          <Link to="/" className="instance-page-back">
            <ArrowLeft size={14} />
            返回首页
          </Link>
          <div className="theme-manage-toolbar-actions">
            <button
              type="button"
              onClick={handleReset}
              disabled={!isDirty || saving}
              className="theme-manage-button"
            >
              <RefreshCw size={14} />
              <span>重置</span>
            </button>
            <button
              type="button"
              onClick={() => void handleCopySiteDefaults()}
              className="theme-manage-button"
              title="复制当前设置的 JSON；粘贴到后台「外观设置 → 主题自定义配置」即可让所有设备用同一套配置"
            >
              {copied ? <ClipboardCheck size={14} /> : <ClipboardCopy size={14} />}
              <span>{copied ? "已复制" : "复制配置 JSON"}</span>
            </button>
            {canSaveToSite && (
              <button
                type="button"
                onClick={() => void handleSaveToSite()}
                disabled={savingSite || saving}
                className="theme-manage-button"
                title="以登录站长身份把当前设置直接写到站点（后端 theme_options），无需再复制 JSON 手动粘贴；成功后本机会自动同步到这套配置"
              >
                {savingSite ? <Spinner size={14} /> : <CloudUpload size={14} />}
                <span>{savingSite ? "保存中" : "保存到站点"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleRestoreSiteDefaults}
              disabled={saving}
              className="theme-manage-button"
              title="丢弃本机保存的主题设置（含配色），改用后台「外观设置 → 主题自定义配置」里最新的 JSON"
            >
              <CloudDownload size={14} />
              <span>同步后台配置</span>
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={
                !isDirty || saving || draftCostRateApiUrlInvalid || draftMultiPingInvalid
              }
              className="theme-manage-button is-primary"
            >
              {saving ? <Spinner size={14} /> : <Save size={14} />}
              <span>{saving ? "保存中" : "保存设置"}</span>
            </button>
          </div>
        </div>
        <div className="theme-masthead-main">
          <div className="theme-masthead-headings">
            <span className="theme-masthead-kicker">LUMINAPLUS · 主题控制台</span>
            <h1 className="theme-masthead-title">主题设置</h1>
            <p className="theme-masthead-desc">
              设置保存在本机浏览器，只影响当前设备；要让所有设备与访客统一，
              {canSaveToSite
                ? "已登录站长可用右上角「保存到站点」一键写入后端，或「复制配置 JSON」手动粘到后台。"
                : "用右上角「复制配置 JSON」粘到后台「外观设置 → 主题自定义配置」。"}
            </p>
          </div>
          <dl className="theme-masthead-meta">
            <div>
              <dt>首页延迟</dt>
              <dd>
                {draft.enableHomepageMultiPing
                  ? `三网 ${draft.homepageMultiPingTaskIds.length} / 3`
                  : `已指定线路 ${assignedNodeCount} / ${sortedClients.length}`}
              </dd>
            </div>
          </dl>
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

      <InstancePanel
        kicker={<><span className="instance-panel-kicker-num">01</span>外观</>}
        title="默认外观"
        description="为首次访问或尚未手动切换外观的用户设置默认显示模式；后续仍可在首页右上角按需切换。"
        aside={<LayoutTemplate size={16} />}
      >
        <div className="instance-segmented is-scrollable">
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
        kicker={<><span className="instance-panel-kicker-num">02</span>视图</>}
        title="默认卡片视图"
        description="分别设置桌面端与移动端的默认卡片尺寸；首页右上角按钮只临时切换当前设备的显示。"
        aside={<LayoutGrid size={16} />}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="surface-inset flex flex-col gap-3 px-4 py-4">
            <div>
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                桌面端默认
              </div>
              <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                适用于宽度大于 720px 的浏览器窗口。
              </div>
            </div>
            <div className="instance-segmented is-scrollable">
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
          <div className="surface-inset flex flex-col gap-3 px-4 py-4">
            <div>
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                移动端默认
              </div>
              <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                适用于宽度小于等于 720px 的手机或窄屏窗口。
              </div>
            </div>
            <div className="instance-segmented is-scrollable">
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
        kicker={<><span className="instance-panel-kicker-num">03</span>背景</>}
        title="卡片透明度"
        description="背景图由后台「外观设置」统一下发到所有主题，这里只调节本主题卡片的不透明度；调低后会自动叠加可读性遮罩。"
        aside={<Wallpaper size={16} />}
      >
        <div className="flex flex-col gap-4">
          <div className="surface-inset flex flex-col gap-3 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] font-semibold text-[var(--text-primary)]">
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
            <span className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              输入 0–100 的整数。100 = 完全不透明，数值越低卡片越通透、越能透出站点背景图。
              低于 95 时会自动叠加一层可读性遮罩，保证文字清晰。
            </span>
          </div>
          <div className="surface-inset px-4 py-3 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            要更换背景图、站点标题或站点图标，请到 <code>/admin#admin</code> 的外观设置中修改，
            它们对所有主题统一生效。
          </div>
        </div>
      </InstancePanel>

      <InstancePanel
        kicker={<><span className="instance-panel-kicker-num">04</span>首页</>}
        title="首页巡检"
        description="控制首页顶部总览、分组筛选和节点排序方式；适合节点较多时快速查看状态。"
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
          <ToggleRow
            field="enableHomeSort"
            title="启用排序切换"
            desc="首页显示排序控件，访客可临时切换排序方式（离线节点恒定置底）。"
            checked={draft.enableHomeSort}
            onPatch={patch}
          />
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)]">
          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">默认排序维度</span>
              <span className="text-[11px] text-[var(--text-tertiary)]">
                首次访问时的初始排序；访客可临时切换。
              </span>
            </div>
            <div className="instance-segmented is-scrollable">
              {HOME_SORT_FIELDS.map((field) => (
                <button
                  key={field}
                  type="button"
                  data-active={draft.homeSortField === field ? "true" : "false"}
                  aria-pressed={draft.homeSortField === field}
                  disabled={!draft.enableHomeSort}
                  onClick={() => patch("homeSortField", field)}
                >
                  {HOME_SORT_FIELD_LABELS[field]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-[13px] font-medium text-[var(--text-primary)]">默认方向</div>
            <div className="instance-segmented">
              <button
                type="button"
                data-active={draft.homeSortDirection === "asc" ? "true" : "false"}
                aria-pressed={draft.homeSortDirection === "asc"}
                disabled={!draft.enableHomeSort}
                onClick={() => patch("homeSortDirection", "asc")}
              >
                升序
              </button>
              <button
                type="button"
                data-active={draft.homeSortDirection === "desc" ? "true" : "false"}
                aria-pressed={draft.homeSortDirection === "desc"}
                disabled={!draft.enableHomeSort}
                onClick={() => patch("homeSortDirection", "desc")}
              >
                降序
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-[13px] font-medium text-[var(--text-primary)]">分组排序</span>
            <span className="text-[11px] text-[var(--text-tertiary)]">
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

        <div className="mt-4 surface-inset px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-[var(--text-primary)]">
                总览评级
              </span>
              <span className="mt-1 block text-[11px] text-[var(--text-tertiary)]">
                在累计流量、实时带宽、资产概览右下角显示文字评级；名称用英文逗号分隔，只取前四个。
              </span>
            </span>
            <label className="inline-flex shrink-0 items-center gap-2 text-[12px] font-medium text-[var(--text-secondary)]">
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
                  <label className="flex items-center justify-between gap-2 text-[12px] font-medium text-[var(--text-secondary)]">
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
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    例如: {defaultLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </InstancePanel>

      <InstancePanel
        kicker={<><span className="instance-panel-kicker-num">05</span>隐藏</>}
        title="隐藏节点"
        description="在此填写的节点会从首页彻底移除：不显示卡片，也不计入在线数、累计流量、实时带宽与资产等所有统计。对所有访客生效，清空即可恢复。"
        aside={<EyeOff size={16} />}
      >
        <label className="flex min-w-0 flex-col gap-2">
          <span className="text-[12px] font-medium text-[var(--text-secondary)]">
            隐藏列表
          </span>
          <textarea
            value={draft.hiddenNodesText}
            onChange={(event) => patch("hiddenNodesText", event.target.value)}
            placeholder="每行一个节点名称 / UUID，也可以用逗号分隔"
            className="surface-inset min-h-[112px] w-full resize-y px-3 py-2 text-[13px] outline-none"
          />
          <span className="text-[11px] text-[var(--text-tertiary)]">
            已隐藏 {draftHiddenNodes.length} 个节点。按名称或 UUID 匹配，大小写不敏感。
          </span>
        </label>
      </InstancePanel>

      <InstancePanel
        kicker={<><span className="instance-panel-kicker-num">06</span>卡片</>}
        title="卡片显示项"
        description="分别管理跨卡片视图的功能入口，以及小卡片专属的信息密度。"
        aside={<Rows3 size={16} />}
      >
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-[13px] font-medium text-[var(--text-primary)]">跨视图设置</span>
            <span className="text-[11px] text-[var(--text-tertiary)]">
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
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-[13px] font-medium text-[var(--text-primary)]">小卡片专属</span>
            <span className="text-[11px] text-[var(--text-tertiary)]">
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

      <InstancePanel
        kicker={<><span className="instance-panel-kicker-num">07</span>花费</>}
        title="服务器花费"
        description="资产统计页（/assets）使用实时汇率计算年化总支出、月均支出与剩余价值；忽略列表中的节点不会计入费用。两个入口开关都关闭时，直接访问资产页也会跳回首页。"
        aside={<CircleDollarSign size={16} />}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
          <div className="flex flex-col gap-3">
            <ToggleRow
              field="showCostSummary"
              title="显示资产页入口按钮"
              desc="在首页资产概览卡右上角显示进入资产统计页的按钮。"
              checked={draft.showCostSummary}
              onPatch={patch}
            />
            <ToggleRow
              field="showCostSummaryFloatingButton"
              title="显示资产悬浮按钮"
              desc="卡内入口不可用时（总览隐藏或其开关关闭），以悬浮按钮进入资产统计页。"
              checked={draft.showCostSummaryFloatingButton}
              onPatch={patch}
            />
            <label className="flex flex-col gap-2">
              <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                实时汇率接口
              </span>
              <input
                value={draft.costRateApiUrl}
                onChange={(event) => patch("costRateApiUrl", event.target.value)}
                placeholder={DEFAULT_THEME_SETTINGS.costRateApiUrl}
                aria-invalid={draftCostRateApiUrlInvalid}
                className="surface-inset w-full px-3 py-2 text-[13px] outline-none"
              />
              {draftCostRateApiUrlInvalid && (
                <span className="text-[12px] text-[var(--status-offline)]">
                  请输入 http(s) 链接，保存后将回退默认接口
                </span>
              )}
            </label>
          </div>
          <label className="flex min-w-0 flex-col gap-2">
            <span className="text-[12px] font-medium text-[var(--text-secondary)]">
              忽略计费节点
            </span>
            <textarea
              value={draft.costIgnoredText}
              onChange={(event) => patch("costIgnoredText", event.target.value)}
              placeholder="每行一个节点名称 / UUID，也可以用逗号分隔"
              className="surface-inset min-h-[112px] w-full resize-y px-3 py-2 text-[13px] outline-none"
            />
          </label>
        </div>
      </InstancePanel>

      <InstancePanel
        kicker={<><span className="instance-panel-kicker-num">08</span>溢价</>}
        title="收购溢价"
        description="填写实际收购价（人民币），系统使用当前价格、周期、到期日和汇率回算收购日的剩余价值，再固化溢价（收购价 − 收购日剩余价值，可正可负）。后续续费和汇率变化不会自动改写；主动修改收购日期时会重新计算并固化。收购日期同时用于溢价月摊与尚未摊销价值；免费节点的收购价全额记为溢价，留空即清除记录。"
        aside={
          <div className="text-[11px] text-[var(--text-tertiary)]">
            {clientsLoading ? "载入中" : `已设置 ${premiumConfiguredCount} 个节点`}
          </div>
        }
      >
        <div className="flex flex-col gap-3">
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

      <InstancePanel
        kicker={<><span className="instance-panel-kicker-num">09</span>延迟</>}
        title="主页延迟检测"
        description={
          <>
            CF-Server-Monitor 的探测点固定为电信 / 联通 / 移动 / BD 四条线路，每台节点都有。
            默认开启三网模式：大卡片和小卡片统一展示指定的三条线路，迷你卡片与列表仍按各自的单线路显示。
            关掉三网模式后走单线路模式，可为每个节点单独指定显示哪条线路，未指定的节点显示电信。
            {" "}
            四条线路的探测目标与探测方式都在后台的服务器编辑里配置，主题读不到。首页的延迟柱状图取自 /api/servers
            下发的一小时探测窗口（不查历史接口，对后端零额外开销）；后端版本较旧、没有该字段时，
            会退回按实时推送逐格累积，那种情况下需要开着页面才会慢慢填满。
          </>
        }
        aside={
          <div className="text-[11px] text-[var(--text-tertiary)]">
            {tasksLoading || clientsLoading
              ? "载入中"
              : draft.enableHomepageMultiPing
                ? `三网 ${draft.homepageMultiPingTaskIds.length} / 3`
                : `${sortedTasks.length} 条线路`}
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div
            className={clsx(
              "surface-inset px-4 py-4",
              draft.enableHomepageMultiPing &&
                "border-[color-mix(in_srgb,var(--accent-500)_32%,var(--hairline))]",
            )}
          >
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-[var(--text-primary)]">
                  开启三网模式
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                  默认开启（电信 / 联通 / 移动）。开启后大卡片和小卡片统一显示下面三条线路；
                  迷你卡片与列表继续按各自的单线路显示。关掉就回到单线路模式。
                </span>
              </span>
              <input
                type="checkbox"
                checked={draft.enableHomepageMultiPing}
                disabled={
                  !draft.enableHomepageMultiPing &&
                  !tasksLoading &&
                  sortedTasks.length < HOMEPAGE_MULTI_PING_TASK_COUNT
                }
                onChange={(event) =>
                  patch("enableHomepageMultiPing", event.target.checked)
                }
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-500)]"
              />
            </label>

            {draft.enableHomepageMultiPing && (
              <div className="mt-4 border-t border-[var(--hairline)] pt-4">
                <div className="grid gap-3 md:grid-cols-3">
                  {Array.from(
                    { length: HOMEPAGE_MULTI_PING_TASK_COUNT },
                    (_, slot) => {
                      const selectedTaskId =
                        draft.homepageMultiPingTaskIds[slot];
                      return (
                        <label key={slot} className="min-w-0">
                          <span className="mb-1.5 block text-[11px] font-medium text-[var(--text-secondary)]">
                            线路 {slot + 1}
                          </span>
                          <select
                            value={selectedTaskId ?? ""}
                            onChange={(event) =>
                              patchMultiPingTask(slot, event.target.value)
                            }
                            aria-label={`三网线路 ${slot + 1}`}
                            className="surface-inset w-full px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none"
                          >
                            <option value="">选择 Ping 任务</option>
                            {selectedTaskId != null &&
                              !sortedTasks.some((task) => task.id === selectedTaskId) && (
                                <option value={selectedTaskId}>
                                  任务 #{selectedTaskId}（当前不可用）
                                </option>
                              )}
                            {sortedTasks.map((task) => (
                              <option
                                key={task.id}
                                value={task.id}
                                disabled={
                                  task.id !== selectedTaskId &&
                                  draft.homepageMultiPingTaskIds.includes(task.id)
                                }
                              >
                                {task.name || `任务 #${task.id}`}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    },
                  )}
                </div>
                <p
                  className={clsx(
                    "mt-3 text-[11px] leading-relaxed",
                    draftMultiPingInvalid
                      ? "text-[var(--status-error)]"
                      : "text-[var(--text-tertiary)]",
                  )}
                  role={draftMultiPingInvalid ? "alert" : undefined}
                >
                  {draftMultiPingInvalid
                    ? "请选满 3 个不同的 Ping 任务后再保存。"
                    : "三项任务按这里的顺序显示；某项任务没有节点样本时保留该行并显示“无样本”。"}
                </p>
              </div>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(240px,320px)]">
            <label className="surface-inset flex items-center gap-2 px-3 py-2">
              <Search size={14} className="text-[var(--text-tertiary)]" />
              <input
                value={taskSearch}
                onChange={(event) => setTaskSearch(event.target.value)}
                placeholder="搜索线路名称"
                aria-label="搜索线路"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-tertiary)]"
              />
            </label>
            <div className="surface-inset flex items-center justify-between gap-3 px-3 py-2 text-[12px] text-[var(--text-secondary)]">
              <span>首页绑定总数</span>
              <strong className="text-[var(--text-primary)]">
                {draft.enableHomepageMultiPing
                  ? `${draft.homepageMultiPingTaskIds.length} / 3 条线路`
                  : `${assignedNodeCount} / ${sortedClients.length}`}
              </strong>
            </div>
          </div>

          {draft.enableHomepageMultiPing && (
            <div className="text-[11px] text-[var(--text-tertiary)]">
              下方单线路绑定继续用于迷你卡片和列表；大卡片与小卡片使用上方三项任务。
            </div>
          )}

          <ToggleRow
            field="fakePingForUnbound"
            title="未绑定节点显示模拟延迟"
            desc="所选线路没有探测数据的在线节点显示前端生成的模拟数据（延迟 1-10ms、丢包 0%）。仅用于视觉统一，不代表真实网络质量；后台没有为该节点配置对应线路的探测目标时会出现这种情况。"
            checked={draft.fakePingForUnbound}
            onPatch={patch}
          />

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
            <div className="surface-inset px-4 py-5 text-[13px] text-[var(--text-secondary)]">
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
                  assigned={
                    draft.homepagePingBindings[String(task.id)] ?? EMPTY_ASSIGNED_CLIENTS
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
      </InstancePanel>
    </div>
  );
}
