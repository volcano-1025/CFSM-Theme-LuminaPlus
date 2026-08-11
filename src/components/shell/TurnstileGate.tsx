import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Spinner } from "@/components/ui/Spinner";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { getSiteConfig } from "@/services/api";
import {
  getTurnstileVerified,
  setTurnstileToken,
} from "@/services/cfsm/config";

/**
 * Turnstile 人机验证。
 *
 * 站点开启全局 API 验证后，未携带验证凭证的请求会被后端以 403 拒绝，主题必须自己完成一次
 * 验证：渲染 Turnstile 组件 → 拿到一次性 token → 带着它请求 `/api/config` →
 * 响应里的 `turnstile_verified` 是加密凭证，缓存约一小时，后续请求复用（见 http.ts）。
 */

const SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Turnstile 脚本加载失败"));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

export function TurnstileGate() {
  const { data: config } = usePublicConfig();
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // 已经拿到缓存凭证或本次请求已通过验证时不打扰用户。
  const needsVerification =
    config?.turnstile_enabled === true &&
    config.verified !== true &&
    !getTurnstileVerified() &&
    Boolean(config.turnstile_site_key);

  const submitToken = useCallback(
    async (token: string) => {
      setVerifying(true);
      setError(null);
      try {
        // 带上一次性 token 请求 config，成功后 http 层会把返回的凭证缓存下来。
        setTurnstileToken(token);
        await getSiteConfig();
        if (!getTurnstileVerified()) {
          throw new Error("验证未通过，请重试");
        }
        await queryClient.invalidateQueries();
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : "验证失败");
      } finally {
        setVerifying(false);
      }
    },
    [queryClient],
  );

  useEffect(() => {
    if (!needsVerification || !config) return;

    let cancelled = false;
    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: config.turnstile_site_key,
          theme: "auto",
          callback: (token) => {
            void submitToken(token);
          },
          "error-callback": () => setError("人机验证组件加载失败"),
          "expired-callback": () => setError("验证已过期，请重新完成验证"),
        });
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "验证组件加载失败");
        }
      });

    return () => {
      cancelled = true;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // 组件已被卸载时忽略。
        }
      }
    };
  }, [config, needsVerification, submitToken]);

  if (!needsVerification) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-0)]/90 backdrop-blur-sm">
      <div className="surface-inset flex w-[min(22rem,90vw)] flex-col items-center gap-4 px-6 py-7 text-center">
        <div className="space-y-1.5">
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">
            请完成人机验证
          </div>
          <p className="text-[13px] text-[var(--text-secondary)]">
            本站开启了 Cloudflare Turnstile 验证，通过后即可查看节点数据。
          </p>
        </div>
        <div ref={containerRef} />
        {verifying && <Spinner size={18} />}
        {error && (
          <p role="alert" className="text-[12px] text-[var(--status-error)]">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
