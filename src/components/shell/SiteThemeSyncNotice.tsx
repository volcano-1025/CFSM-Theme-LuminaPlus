import { useEffect, useId, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Cloud, CloudAlert, History } from "lucide-react";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import {
  checkSiteThemeBackup,
  dismissSiteThemeBackup,
  restoreSiteThemeBackup,
  retrySiteThemeSync,
  startSiteThemeAutoSync,
  useCanSyncSiteTheme,
  useSiteThemeSyncStatus,
  type SiteThemeBackupCheck,
} from "@/hooks/useSiteThemeOptions";
import { ApiRequestError } from "@/services/cfsm/http";

function describeSyncError(error: unknown): string {
  const status = error instanceof ApiRequestError ? error.status : 0;
  if (status === 401) return "登录态已失效：到 /admin 重新登录后点「重试」，改动先留在本机。";
  // http 层清掉失效的人机验证凭证后，全局验证弹窗会自己重新出来（见 TurnstileGate）。
  if (status === 403) return "本站需要人机验证：完成弹出的验证后点「重试」。";
  if (status === 400) return "配置格式被后端拒绝（invalidThemeOptionsFormat），请把这条信息反馈给作者。";
  return error instanceof Error && error.message ? error.message : "网络错误，改动先留在本机。";
}

function describeRestoreError(error: unknown): string {
  const status = error instanceof ApiRequestError ? error.status : 0;
  if (status === 401) return "登录态已失效：到 /admin 重新登录后再点一次恢复。";
  if (status === 403) return "本站需要人机验证：完成弹出的验证后再点一次恢复。";
  return error instanceof Error && error.message ? `恢复失败：${error.message}` : "恢复失败，请稍后再试。";
}

function formatBackupTime(at: number | null): string {
  if (at == null) return "上次";
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 同步成功的提示停留多久。 */
const SUCCESS_NOTICE_MS = 3200;

/**
 * 登录站长的改动自动同步到后端（设置页、卡片配色、卡片上换线路都走这一条，见 startSiteThemeAutoSync）。
 * 这里负责启动监听，并提示结果 —— 改动是在首页取色器、卡片上做的，除了这儿没别的地方能说。
 *
 * 成功的提示只在设置页**之外**出现几秒：设置页顶栏自己有同步状态，两边一起说就重复了。
 *
 * 后端配置被别的主题 / 后台旧副本整份改掉时（见 checkSiteThemeBackup），也在这里问要不要恢复。三种提示同一个位置，
 * 同步失败优先，其次恢复，最后才是成功。
 */
export function SiteThemeSyncNotice() {
  const titleId = useId();
  const status = useSiteThemeSyncStatus();
  const [dismissedError, setDismissedError] = useState<unknown>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const previousPhase = useRef(status.phase);
  const { search } = useLocation();
  const onSettingsPage = new URLSearchParams(search).get("view") === "theme-manage";
  const backupTitleId = useId();
  const { data: config } = usePublicConfig();
  const canSyncSiteTheme = useCanSyncSiteTheme();
  const [backupCheck, setBackupCheck] = useState<SiteThemeBackupCheck | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => startSiteThemeAutoSync(), []);

  // 只给登录站长判；自己的同步在路上时不判（发出去之前后端当然还是旧的）。
  const syncBusy = status.phase === "pending" || status.phase === "saving";
  useEffect(() => {
    if (!canSyncSiteTheme || !config || syncBusy) return;
    setBackupCheck(checkSiteThemeBackup(config.theme_settings, config.preferredAppearance));
  }, [canSyncSiteTheme, config, syncBusy]);

  const handleRestore = async () => {
    setRestoring(true);
    setRestoreError(null);
    try {
      if (!(await restoreSiteThemeBackup())) setRestoreError("正在同步别的改动，稍后再点一次恢复。");
    } catch (error) {
      setRestoreError(describeRestoreError(error));
    } finally {
      setRestoring(false);
    }
  };

  const handleDismissBackup = () => {
    if (!backupCheck) return;
    dismissSiteThemeBackup(backupCheck.fingerprint);
    setBackupCheck({ ...backupCheck, overwritten: false });
    setRestoreError(null);
  };

  // 只认「发出去之后回来了」这一次跳变：idle → synced（没发请求，快照和站点一样）不提示。
  useEffect(() => {
    const wasSaving = previousPhase.current === "saving";
    previousPhase.current = status.phase;
    if (status.phase !== "synced" || !wasSaving) return;
    setShowSuccess(true);
    const timer = window.setTimeout(() => setShowSuccess(false), SUCCESS_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [status.phase]);

  if (status.phase !== "error" || status.error === dismissedError) {
    if (canSyncSiteTheme && backupCheck?.overwritten && (!syncBusy || restoring)) {
      return (
        <section
          className="realtime-session-prompt site-theme-sync-notice"
          aria-labelledby={backupTitleId}
          aria-live="polite"
        >
          <History size={16} strokeWidth={2} className="realtime-session-prompt-icon" aria-hidden />
          <div className="realtime-session-prompt-body">
            <strong id={backupTitleId}>主题设置被改过了</strong>
            <p>
              {restoreError ??
                `后端现在的设置和这台设备 ${formatBackupTime(backupCheck.backupAt)} 同步的不一样，可能是切过别的主题，或在后台保存时写回了旧配置。`}
            </p>
          </div>
          <div className="realtime-session-prompt-actions">
            <button
              type="button"
              className="control-button realtime-session-prompt-button"
              onClick={handleDismissBackup}
              disabled={restoring}
            >
              忽略
            </button>
            <button
              type="button"
              className="control-button realtime-session-prompt-button is-primary"
              onClick={() => void handleRestore()}
              disabled={restoring}
              aria-busy={restoring}
            >
              {restoring ? "恢复中" : "恢复上次的设置"}
            </button>
          </div>
        </section>
      );
    }
    if (!showSuccess || onSettingsPage) return null;
    return (
      <section
        className="realtime-session-prompt site-theme-sync-notice is-success"
        aria-live="polite"
      >
        <Cloud size={16} strokeWidth={2} className="realtime-session-prompt-icon" aria-hidden />
        <div className="realtime-session-prompt-body">
          <strong>改动已同步到后端</strong>
          <p>所有设备与访客都会用这套配置。</p>
        </div>
      </section>
    );
  }

  return (
    <section
      className="realtime-session-prompt site-theme-sync-notice"
      aria-labelledby={titleId}
      aria-live="polite"
    >
      <CloudAlert size={16} strokeWidth={2} className="realtime-session-prompt-icon" aria-hidden />
      <div className="realtime-session-prompt-body">
        <strong id={titleId}>设置没能同步到后端</strong>
        <p>{describeSyncError(status.error)}</p>
      </div>
      <div className="realtime-session-prompt-actions">
        <button
          type="button"
          className="control-button realtime-session-prompt-button"
          onClick={() => setDismissedError(status.error)}
        >
          关闭
        </button>
        <button
          type="button"
          className="control-button realtime-session-prompt-button is-primary"
          onClick={retrySiteThemeSync}
        >
          重试
        </button>
      </div>
    </section>
  );
}
