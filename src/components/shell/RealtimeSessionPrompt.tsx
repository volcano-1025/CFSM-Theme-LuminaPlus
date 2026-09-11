import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Unplug } from "lucide-react";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import {
  getStoreStatusSnapshot,
  resumeRealtimeSession,
  setRealtimeSessionLimitMinutes,
  subscribeStoreStatus,
} from "@/services/wsStore";

/**
 * 「实时连接已达到时限」提示（后台「前端实时连接超时」`frontend_ws_timeout_minutes`）。
 *
 * 后端只把时限下发给前端，到点断开、问用户是否继续都是前端的事；不接的话站长的这个设置对本主题
 * 等于没有，忘在屏幕上的页面会一直占着实时连接、让探针高频上报。点「关闭」就保持断开，不静默重连
 * （后端文档：不应在用户选择关闭后静默重连），刷新页面才重新开始。
 * 不做成模态：提示出现时人多半不在屏幕前，挡住页面没有意义。
 */
export function RealtimeSessionPrompt() {
  const { data: config } = usePublicConfig();
  const minutes = config?.frontendWsTimeoutMinutes ?? 0;
  const titleId = useId();
  const status = useSyncExternalStore(
    subscribeStoreStatus,
    getStoreStatusSnapshot,
    getStoreStatusSnapshot,
  );
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setRealtimeSessionLimitMinutes(minutes);
  }, [minutes]);

  // 恢复之后清掉「关闭过」，下一次到时限还要再问。
  useEffect(() => {
    if (!status.realtimeSessionExpired) setDismissed(false);
  }, [status.realtimeSessionExpired]);

  if (!status.realtimeSessionExpired || dismissed) return null;

  return (
    <section className="realtime-session-prompt" aria-labelledby={titleId} aria-live="polite">
      <Unplug size={16} strokeWidth={2} className="realtime-session-prompt-icon" aria-hidden />
      <div className="realtime-session-prompt-body">
        <strong id={titleId}>实时连接已达到时限并断开</strong>
        <p>
          {minutes > 0 ? `站点限制单次实时连接 ${minutes} 分钟，` : ""}页面停在断开前的数据。
        </p>
      </div>
      <div className="realtime-session-prompt-actions">
        <button
          type="button"
          className="control-button realtime-session-prompt-button"
          onClick={() => setDismissed(true)}
        >
          关闭
        </button>
        <button
          type="button"
          className="control-button realtime-session-prompt-button is-primary"
          onClick={resumeRealtimeSession}
        >
          继续接收
        </button>
      </div>
    </section>
  );
}
