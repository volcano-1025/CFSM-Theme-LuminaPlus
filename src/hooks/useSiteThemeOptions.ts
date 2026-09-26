import { useMemo, useSyncExternalStore } from "react";
import { pickPaletteSettings } from "@/hooks/useMetricColors";
import { useAllPingLineOverrides } from "@/hooks/usePingOverview";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { useLocalThemeSettings } from "@/hooks/useThemeSettings";
import { getPublic, saveThemeOptions } from "@/services/api";
import { getJwtToken } from "@/services/cfsm/config";
import {
  clearPingLineOverrides,
  getAllPingLineOverrides,
  subscribePingLineOverrideEdits,
} from "@/services/pingLineOverrideStore";
import { queryClient } from "@/services/queryClient";
import {
  getLocalThemeSettings,
  resetLocalThemeSettings,
  subscribeLocalThemeSettingsEdits,
} from "@/services/themeSettingsStore";
import type { Me, PublicConfig, ThemeSettings } from "@/types/cfsm";
import {
  EMPTY_PING_LINE_OVERRIDES_BY_NODE,
  mergePingLineOverridesByNode,
  type PingLineOverridesByNode,
} from "@/utils/pingLineOverrides";
import {
  normalizeThemeSettings,
  withPreferredAppearance,
  type Appearance,
} from "@/utils/themeSettings";

export interface SiteThemeOptionsSources {
  /** 后端当前的 theme_options（站点预设）。 */
  siteSettings: Record<string, unknown> | undefined;
  /** 后台「默认外观」，主题设置里没写默认外观时垫底。 */
  preferredAppearance: Appearance | undefined;
  /** 本机覆盖（localStorage）。 */
  localSettings: Record<string, unknown>;
  /** 设置页还没保存的表单草稿；取色器没有。 */
  draftSettings?: ThemeSettings;
  /** 首页卡片上换过的线路（本机那份）。 */
  localLineOverrides: PingLineOverridesByNode;
}

/**
 * 「复制配置 JSON」与登录站长自动同步到后端发出去的站点快照，口径只在这里定：
 *
 * 1. 主题设置白名单（normalizeThemeSettings）：站点 → 本机 → 草稿逐层盖，默认外观先垫后台的设置；
 * 2. 卡片上换过的线路按行并进 `homepagePingLineOverrides`；
 * 3. 配色逐个颜色叠（pickPaletteSettings），不能跟着第 1 条整键盖。
 *
 * 取色器的「保存到后端」早先自己拼了一份：没垫后台默认外观 —— 主题设置里没写默认外观时写成了
 * 「跟随系统」，把后台设的深色 / 浅色对所有访客盖掉；也没带卡片上换的线路。
 */
export function buildSiteThemeOptions({
  siteSettings,
  preferredAppearance,
  localSettings,
  draftSettings,
  localLineOverrides,
}: SiteThemeOptionsSources): Record<string, unknown> {
  const normalized = normalizeThemeSettings(
    withPreferredAppearance(preferredAppearance, {
      ...(siteSettings ?? {}),
      ...localSettings,
      ...draftSettings,
    }) as ThemeSettings & Record<string, unknown>,
  );
  return {
    ...normalized,
    // 本机换过的行压过站点已存的那份（见 mergePingLineOverridesByNode）。
    homepagePingLineOverrides: mergePingLineOverridesByNode(
      normalized.homepageMultiPingTaskIds,
      normalized.homepagePingLineOverrides,
      localLineOverrides,
    ),
    ...pickPaletteSettings(siteSettings, localSettings),
  };
}

/** 当前设备的站点快照（未登录时「复制配置 JSON」导出的就是它）。 */
export function useSiteThemeOptions(draftSettings?: ThemeSettings) {
  const { data: config } = usePublicConfig();
  const localSettings = useLocalThemeSettings();
  const localLineOverrides = useAllPingLineOverrides();

  const snapshot = useMemo(
    () =>
      buildSiteThemeOptions({
        siteSettings: config?.theme_settings,
        preferredAppearance: config?.preferredAppearance,
        localSettings,
        draftSettings,
        localLineOverrides,
      }),
    [
      config?.preferredAppearance,
      config?.theme_settings,
      draftSettings,
      localLineOverrides,
      localSettings,
    ],
  );

  return { snapshot };
}

/* ------------------------------------------------------------------ *
 * 登录站长：改动自动同步到后端
 * ------------------------------------------------------------------ */

/**
 * 最后一次改动之后等多久再发。拖取色器每一帧都在改，连打字也是一下一次；后端每次保存都写一次 D1，
 * 等人停手再发一次就够了。
 */
export const SITE_THEME_SYNC_DEBOUNCE_MS = 1_000;

/**
 * 「有改动还没同步上」的标记。改完没等到发出去就关了页、登录态失效、断网，改动都还留在本机；
 * 下次打开据此接着发。不看「本机有没有覆盖」本身：自动同步上线前站长存在本机的旧设置，不该一打开
 * 就被推到后端、盖掉他在别的设备上的配置（这台设备上再改任何一项时才会连同它们一起发）。
 */
const SYNC_PENDING_STORAGE_KEY = "cfsm-luminaplus:site-sync-pending";

export type SiteThemeSyncPhase = "idle" | "pending" | "saving" | "synced" | "error";

export interface SiteThemeSyncStatus {
  phase: SiteThemeSyncPhase;
  /** phase 为 error 时的原始错误，由界面按状态码提示。 */
  error: unknown;
}

const IDLE_STATUS: SiteThemeSyncStatus = { phase: "idle", error: null };

let syncStatus = IDLE_STATUS;
const syncStatusListeners = new Set<() => void>();
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncRunning = false;
let syncRerun = false;
let editSeq = 0;

function setSyncStatus(next: SiteThemeSyncStatus) {
  syncStatus = next;
  for (const listener of syncStatusListeners) listener();
}

function writeSyncPending(pending: boolean) {
  try {
    if (pending) window.localStorage.setItem(SYNC_PENDING_STORAGE_KEY, String(Date.now()));
    else window.localStorage.removeItem(SYNC_PENDING_STORAGE_KEY);
  } catch {
    // 写不进去只是少了「下次打开接着发」，本次会话照常同步。
  }
}

function readSyncPending(): boolean {
  try {
    return window.localStorage.getItem(SYNC_PENDING_STORAGE_KEY) != null;
  } catch {
    return false;
  }
}

/**
 * 这台设备的改动要不要自动同步到后端：有令牌，且登录校验（`["me"]`）没判成未登录。
 * 光看令牌不够：令牌过期的老访客每改一次颜色都会撞一次 401。
 */
export function canSyncSiteTheme(): boolean {
  if (!getJwtToken()) return false;
  return queryClient.getQueryData<Me>(["me"])?.logged_in !== false;
}

/** 设置页、取色器判断「登录站长」用，与自动同步同口径；随登录校验结果更新。 */
export function useCanSyncSiteTheme(): boolean {
  const me = useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => queryClient.getQueryData<Me>(["me"]),
  );
  return Boolean(getJwtToken()) && me?.logged_in !== false;
}

function scheduleSync(delayMs: number) {
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void runSync();
  }, delayMs);
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function handleLocalEdit() {
  if (!canSyncSiteTheme()) return;
  editSeq += 1;
  writeSyncPending(true);
  if (!syncRunning) setSyncStatus({ phase: "pending", error: null });
  scheduleSync(SITE_THEME_SYNC_DEBOUNCE_MS);
}

/**
 * 把「站点配置 + 本机改动」整份发到后端（`POST /api/theme_options`），成功后本机改动清掉、以后端为准。
 *
 * - 同一时刻只跑一个请求：途中又改过就等这次回来再发一轮，两次请求乱序到达会让旧快照盖掉新的；
 * - **发之前重拉一次 `/api/config` 当底**：快照整份替换后端的 theme_options，拿缓存里那份当底的话，
 *   页面开了几个小时，站长这期间在别的设备上改的会被这台设备的旧副本静默盖掉（config 缓存不会自己刷新）。
 *   刚保存完那两分钟里后端可能回旧的一份，getPublic 那时以自己写进去的为准（见 api 的 THEME_OPTIONS_WRITE_TRUST_MS）；
 *   拉不到就不发，报错等重试 —— 拿旧底发出去正是要避免的事；
 * - 成功后**先写 config 缓存、再丢本机**，反过来中间那次渲染是「旧站点配置 + 空的本机」，页面会闪回旧设置；
 *   只丢发出去的那份，请求途中又改过的留着下一轮一起发；
 * - 快照和站点现有的一样就不发（比如颜色又调回了站点色），本机那份照样清掉；
 * - 发出去的快照带上 {@link SITE_SYNC_MARKER_KEY}，成功后本机留一份备份（见下面「备份与恢复」）；
 * - 失败不自动重试：401/403 重试也是一样的结果，等用户重试或下一次改动。
 */
async function runSync() {
  if (syncRunning) {
    syncRerun = true;
    return;
  }
  syncRunning = true;
  const seq = editSeq;
  setSyncStatus({ phase: "saving", error: null });
  try {
    const config = await queryClient.fetchQuery<PublicConfig>({
      queryKey: ["public"],
      queryFn: ({ signal }) => getPublic({ signal }),
      staleTime: 0,
    });
    const localSettings = getLocalThemeSettings();
    const localLineOverrides = getAllPingLineOverrides();
    const site = {
      siteSettings: config.theme_settings,
      preferredAppearance: config.preferredAppearance,
      localSettings: {},
      localLineOverrides: EMPTY_PING_LINE_OVERRIDES_BY_NODE,
    };
    const snapshot = buildSiteThemeOptions({ ...site, localSettings, localLineOverrides });
    if (!sameJson(snapshot, buildSiteThemeOptions(site))) {
      const { theme_options: saved } = await saveThemeOptions({
        ...snapshot,
        [SITE_SYNC_MARKER_KEY]: Date.now(),
      });
      queryClient.setQueryData<PublicConfig>(["public"], (current) =>
        current ? { ...current, theme_settings: saved } : current,
      );
      writeSiteThemeBackup(saved);
    }
    if (sameJson(getLocalThemeSettings(), localSettings)) resetLocalThemeSettings();
    if (sameJson(getAllPingLineOverrides(), localLineOverrides)) clearPingLineOverrides();
    if (editSeq === seq) {
      writeSyncPending(false);
      setSyncStatus({ phase: "synced", error: null });
    }
  } catch (error) {
    setSyncStatus({ phase: "error", error });
  } finally {
    syncRunning = false;
    if (syncRerun || editSeq !== seq) {
      syncRerun = false;
      if (syncTimer === undefined) scheduleSync(0);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 备份与恢复：后端被别人整份改掉时，从这台设备上次同步的那份恢复
 * ------------------------------------------------------------------ */

/**
 * 同步时随快照写进后端的时间戳（毫秒）。只有本主题认它，别人写 theme_options 时它要么没了、要么变旧：
 *
 * - 别的主题按自己的白名单整份替换，不认识这个键就丢了。2026-09-26 站长切过 SAO（本主题的分叉，连本机存储的
 *   键名都一样），切回来卡片线路、地区顺序全没了，后端没留任何痕迹；
 * - 后台「应用」主题 / 「保存设置」写回页面打开时读的旧副本，里面是更早的一次同步的时间戳。
 */
export const SITE_SYNC_MARKER_KEY = "luminaplusSyncedAt";
const BACKUP_STORAGE_KEY = "cfsm-luminaplus:site-theme-backup:v1";
const BACKUP_DISMISSED_STORAGE_KEY = "cfsm-luminaplus:site-theme-backup-dismissed:v1";
/**
 * 备份写下后这么久之内不判「被改过」：后端每个 isolate 各缓存配置 120 秒，刚同步完刷新页面，
 * 可能拿到的还是上一次同步的那份（时间戳更旧），会被误认成旧副本写回。
 */
export const SITE_BACKUP_SETTLE_MS = 3 * 60_000;

function syncMarkerOf(themeOptions: Record<string, unknown> | undefined): number | null {
  const value = themeOptions?.[SITE_SYNC_MARKER_KEY];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 键按字母排好再序列化：后端存取之后键的顺序不保证不变，内容一样的两份不该被当成不同。 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    current && typeof current === "object" && !Array.isArray(current)
      ? Object.fromEntries(
          Object.keys(current)
            .sort()
            .map((key) => [key, (current as Record<string, unknown>)[key]]),
        )
      : current,
  );
}

function readSiteThemeBackup(): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(BACKUP_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeSiteThemeBackup(themeOptions: Record<string, unknown>): void {
  if (syncMarkerOf(themeOptions) == null) return;
  try {
    window.localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(themeOptions));
    window.localStorage.removeItem(BACKUP_DISMISSED_STORAGE_KEY);
  } catch {
    // 存不下只是少了这层保险，同步本身不受影响。
  }
}

function readDismissedFingerprint(): string | null {
  try {
    return window.localStorage.getItem(BACKUP_DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface SiteThemeBackupCheck {
  /** 后端配置被别人改过、而且改动落在本主题的设置上：该问站长要不要恢复。 */
  overwritten: boolean;
  /** 备份是哪次同步写下的（毫秒）。 */
  backupAt: number | null;
  /** 后端这一份的指纹，「忽略」时记下它，同一份不再问。 */
  fingerprint: string;
}

/**
 * 看后端现在这份是不是被别人改过（登录站长打开页面、config 更新时调用）。
 *
 * - 后端的时间戳不比备份旧：是本主题写的（可能是别的设备），备份换成它 —— 以后要恢复就恢复到最新的一份，
 *   不会拿这台设备更早的备份把别的设备后来的改动冲掉；
 * - 没有时间戳，或比备份旧：别人写的。只在本主题的设置真的变了时才算（`buildSiteThemeOptions` 按白名单比，
 *   后台只是多塞了别的主题的键不算），刚同步完 {@link SITE_BACKUP_SETTLE_MS} 内不算。
 */
export function checkSiteThemeBackup(
  backend: Record<string, unknown> | undefined,
  preferredAppearance: Appearance | undefined,
  now = Date.now(),
): SiteThemeBackupCheck {
  const fingerprint = stableJson(backend ?? {});
  const backup = readSiteThemeBackup();
  const backupAt = syncMarkerOf(backup ?? undefined);
  const backendAt = syncMarkerOf(backend);
  const result = { overwritten: false, backupAt, fingerprint };
  if (!backend) return result;
  if (backendAt != null && (backupAt == null || backendAt >= backupAt)) {
    if (backendAt !== backupAt) writeSiteThemeBackup(backend);
    return { ...result, backupAt: backendAt };
  }
  if (!backup || backupAt == null || now - backupAt < SITE_BACKUP_SETTLE_MS) return result;
  const ours = (siteSettings: Record<string, unknown>) =>
    buildSiteThemeOptions({
      siteSettings,
      preferredAppearance,
      localSettings: {},
      localLineOverrides: EMPTY_PING_LINE_OVERRIDES_BY_NODE,
    });
  if (sameJson(ours(backend), ours(backup))) return result;
  return { ...result, overwritten: readDismissedFingerprint() !== fingerprint };
}

/** 「忽略」：这一份不再问，后端再变（或本主题再同步一次）才会重新判断。 */
export function dismissSiteThemeBackup(fingerprint: string): void {
  try {
    window.localStorage.setItem(BACKUP_DISMISSED_STORAGE_KEY, fingerprint);
  } catch {
    // 记不下就是下次打开还会问一遍。
  }
}

/**
 * 把备份整份写回后端（带新的时间戳）。和自动同步共用「同一时刻只一个请求」：同步在跑就不动，由调用方提示稍后再试。
 * 失败时状态退回原样、把错误抛给调用方自己提示 —— 不走同步失败那条提示，那条的「重试」重发的是本机改动，不是恢复。
 */
export async function restoreSiteThemeBackup(): Promise<boolean> {
  const backup = readSiteThemeBackup();
  if (!backup || syncRunning) return false;
  syncRunning = true;
  const previous = syncStatus;
  setSyncStatus({ phase: "saving", error: null });
  try {
    const { theme_options: saved } = await saveThemeOptions({
      ...backup,
      [SITE_SYNC_MARKER_KEY]: Date.now(),
    });
    queryClient.setQueryData<PublicConfig>(["public"], (current) =>
      current ? { ...current, theme_settings: saved } : current,
    );
    writeSiteThemeBackup(saved);
    setSyncStatus({ phase: "synced", error: null });
    return true;
  } catch (error) {
    setSyncStatus(previous);
    throw error;
  } finally {
    syncRunning = false;
    if (syncRerun) {
      syncRerun = false;
      if (syncTimer === undefined) scheduleSync(0);
    }
  }
}

/**
 * 开始监听本机改动（AppShell 挂载时调用一次）。上次有没同步上的改动，这次打开接着发。
 */
export function startSiteThemeAutoSync(): () => void {
  const stopThemeEdits = subscribeLocalThemeSettingsEdits(handleLocalEdit);
  const stopLineEdits = subscribePingLineOverrideEdits(handleLocalEdit);
  if (readSyncPending() && getJwtToken()) {
    editSeq += 1;
    scheduleSync(SITE_THEME_SYNC_DEBOUNCE_MS);
  }
  return () => {
    stopThemeEdits();
    stopLineEdits();
    if (syncTimer !== undefined) clearTimeout(syncTimer);
    syncTimer = undefined;
  };
}

/**
 * 登录站长这台设备上有没有「没同步上去的本机改动」—— 设置页据此决定给不给「改用后端配置」。
 *
 * 正在同步（等防抖、请求在路上、表单还没到自动保存）时不算：那时本机本来就有改动，按钮会在每次编辑时
 * 闪出来又消失。剩下的就是同步失败留在本机的，和自动同步上线前存在本机、还没随编辑发出去的旧设置。
 */
export function hasUnsyncedLocalChanges({
  hasLocalChanges,
  phase,
  waiting,
}: {
  hasLocalChanges: boolean;
  phase: SiteThemeSyncPhase;
  /** 设置页表单改了、还没存进本机。 */
  waiting: boolean;
}): boolean {
  if (!hasLocalChanges || waiting) return false;
  return phase !== "pending" && phase !== "saving";
}

/** 失败后手动重试（登录态失效重新登录回来、完成人机验证之后）。 */
export function retrySiteThemeSync(): void {
  if (!getJwtToken()) return;
  editSeq += 1;
  scheduleSync(0);
}

/**
 * 「改用后端配置」：本机改动整份丢掉，还没发出去的那次也不发了。已经在路上的请求拦不回来。
 */
export function cancelSiteThemeSync(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = undefined;
  writeSyncPending(false);
  if (!syncRunning) setSyncStatus(IDLE_STATUS);
}

export function getSiteThemeSyncStatus(): SiteThemeSyncStatus {
  return syncStatus;
}

export function subscribeSiteThemeSyncStatus(listener: () => void): () => void {
  syncStatusListeners.add(listener);
  return () => {
    syncStatusListeners.delete(listener);
  };
}

export function useSiteThemeSyncStatus(): SiteThemeSyncStatus {
  return useSyncExternalStore(
    subscribeSiteThemeSyncStatus,
    getSiteThemeSyncStatus,
    getSiteThemeSyncStatus,
  );
}

/** 测试用：回到初始状态。 */
export function resetSiteThemeSyncForTest(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = undefined;
  syncRunning = false;
  syncRerun = false;
  editSeq = 0;
  syncStatus = IDLE_STATUS;
  writeSyncPending(false);
}
