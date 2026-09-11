import { useId, type ReactNode } from "react";
import { useVersionInfo } from "@/hooks/useVersionInfo";
import { formatVersionLabel } from "@/utils/versionCompare";

/**
 * 站点底部署名：后端项目 + 本主题，各带 GitHub 链接。
 *
 * 由后端作者提出，两条都放到每一页的最下面。链接写死在这里而不是走后台配置：这是「这套面板由什么构成」
 * 的事实，不是站长可配置的展示项。
 *
 * 版本号不直接显示，鼠标放到名字上才在上方弹出（站长要页脚保持干净）。有新版本时名字后面跟一个「新版 vX」
 * 小标签，只给登录站长看 —— 访客升级不了，后端也只对登录请求下发最新版本号。这是唯一的更新提醒入口：
 * 快捷栏上的小点做过又撤掉了，站长不要。
 */

const BACKEND_REPO_URL = "https://github.com/huilang-me/CF-Server-Monitor";
const THEME_REPO_URL = "https://github.com/volcano-1025/CFSM-Theme-LuminaPlus";
const THEME_CHANGELOG_URL = `${THEME_REPO_URL}/blob/main/CHANGELOG.md`;

export function SiteFooter() {
  const { backend, theme } = useVersionInfo();
  return (
    <footer className="site-footer">
      <span className="site-footer-item">
        Powered by{" "}
        <FooterLink href={BACKEND_REPO_URL} hint={versionHint(backend.current)}>
          CF-Server-Monitor
        </FooterLink>
        {backend.update && (
          <UpdateBadge href={BACKEND_REPO_URL} current={backend.current} update={backend.update} />
        )}
      </span>
      <span className="site-footer-sep" aria-hidden>
        ·
      </span>
      <span className="site-footer-item">
        Theme by{" "}
        <FooterLink href={THEME_REPO_URL} hint={versionHint(theme.current)}>
          LuminaPlus
        </FooterLink>
        {theme.update && (
          <UpdateBadge href={THEME_CHANGELOG_URL} current={theme.current} update={theme.update} />
        )}
      </span>
    </footer>
  );
}

function versionHint(version: string | null): string | null {
  return version ? formatVersionLabel(version) : null;
}

/**
 * 悬停时在上方弹出的小提示。不用原生 `title`：浏览器只会把它弹在光标下方、样式也改不了，
 * 而站长要的是「在上方弹、只写版本号」。
 */
function HintBubble({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} role="tooltip" className="site-footer-tooltip">
      {children}
    </span>
  );
}

function FooterLink({
  href,
  hint,
  children,
}: {
  href: string;
  hint: string | null;
  children: ReactNode;
}) {
  const hintId = useId();
  const link = (
    <a
      className="site-footer-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-describedby={hint ? hintId : undefined}
    >
      {children}
    </a>
  );
  if (!hint) return link;
  return (
    <span className="site-footer-hint">
      {link}
      <HintBubble id={hintId}>{hint}</HintBubble>
    </span>
  );
}

/** 「新版 vX」标签；悬停同样在上方弹，写「当前 → 新版」（当前版本拿不到时只写新版本）。 */
function UpdateBadge({
  href,
  current,
  update,
}: {
  href: string;
  current: string | null;
  update: string;
}) {
  const hintId = useId();
  const next = formatVersionLabel(update);
  return (
    <span className="site-footer-hint site-footer-update-hint">
      <a
        className="site-footer-update"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={hintId}
      >
        新版 {next}
      </a>
      <HintBubble id={hintId}>{current ? `${formatVersionLabel(current)} → ${next}` : next}</HintBubble>
    </span>
  );
}
