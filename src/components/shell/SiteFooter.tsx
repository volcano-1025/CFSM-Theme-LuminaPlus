import { useVersionInfo } from "@/hooks/useVersionInfo";
import { formatVersionLabel } from "@/utils/versionCompare";

/**
 * 站点底部署名：后端项目 + 本主题，各带 GitHub 链接。
 *
 * 由后端作者提出，两条都放到每一页的最下面。链接写死在这里而不是走后台配置：这是「这套面板由什么构成」
 * 的事实，不是站长可配置的展示项。
 *
 * 版本号不直接显示，鼠标放到名字上才看得到（站长要页脚保持干净）。有新版本时名字后面跟一个「新版 vX」
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
        <a
          className="site-footer-link"
          href={BACKEND_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={versionTitle("CF-Server-Monitor", backend.current)}
        >
          CF-Server-Monitor
        </a>
        {backend.update && (
          <UpdateBadge
            href={BACKEND_REPO_URL}
            version={backend.update}
            title={`后端有新版本（${upgradePath(backend.current, backend.update)}）：按后端 README 的说明升级 Workers`}
          />
        )}
      </span>
      <span className="site-footer-sep" aria-hidden>
        ·
      </span>
      <span className="site-footer-item">
        Theme by{" "}
        <a
          className="site-footer-link"
          href={THEME_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={versionTitle("LuminaPlus", theme.current)}
        >
          LuminaPlus
        </a>
        {theme.update && (
          <UpdateBadge
            href={THEME_CHANGELOG_URL}
            version={theme.update}
            title={`主题有新版本（${upgradePath(theme.current, theme.update)}）：到后台「主题商店」切换版本；点这里看更新了什么`}
          />
        )}
      </span>
    </footer>
  );
}

/** 名字上的悬停提示：`CF-Server-Monitor v2.8.5 Beta5`；版本拿不到就不给提示。 */
function versionTitle(name: string, version: string | null): string | undefined {
  return version ? `${name} ${formatVersionLabel(version)}` : undefined;
}

/** `v1.2.15 → v1.2.16`；当前版本拿不到时只写新版本。 */
function upgradePath(current: string | null, update: string): string {
  return current
    ? `${formatVersionLabel(current)} → ${formatVersionLabel(update)}`
    : formatVersionLabel(update);
}

function UpdateBadge({ href, version, title }: { href: string; version: string; title: string }) {
  return (
    <a
      className="site-footer-update"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
    >
      新版 {formatVersionLabel(version)}
    </a>
  );
}
