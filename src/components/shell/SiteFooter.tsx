import { useVersionInfo } from "@/hooks/useVersionInfo";
import { formatVersionLabel } from "@/utils/versionCompare";

/**
 * 站点底部署名：后端项目 + 本主题，各带 GitHub 链接和版本号。
 *
 * 由后端作者提出，两条都放到每一页的最下面；版本号按后端文档建议的写法跟在名字后面
 * （`Powered by CF-Server-Monitor v…`）。链接写死在这里而不是走后台配置：这是「这套面板由什么构成」
 * 的事实，不是站长可配置的展示项。
 *
 * 有新版本时版本号后面跟一个「新版 vX」小标签，只给登录站长看 —— 访客升级不了，后端也只对登录请求
 * 下发最新版本号。右上角快捷栏管理按钮上的小点是同一份信息（见 FloatingControls）。
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
        >
          CF-Server-Monitor
        </a>
        {backend.current && (
          <span className="site-footer-version">{formatVersionLabel(backend.current)}</span>
        )}
        {backend.update && (
          <UpdateBadge
            href={BACKEND_REPO_URL}
            version={backend.update}
            title={`后端有新版本 ${formatVersionLabel(backend.update)}：按后端 README 的说明升级 Workers`}
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
        >
          LuminaPlus
        </a>
        {theme.current && (
          <span className="site-footer-version">{formatVersionLabel(theme.current)}</span>
        )}
        {theme.update && (
          <UpdateBadge
            href={THEME_CHANGELOG_URL}
            version={theme.update}
            title={`主题有新版本 ${formatVersionLabel(theme.update)}：到后台「主题商店」切换版本；点这里看更新了什么`}
          />
        )}
      </span>
    </footer>
  );
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
