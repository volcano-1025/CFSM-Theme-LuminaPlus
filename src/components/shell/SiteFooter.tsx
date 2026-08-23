/**
 * 站点底部署名：后端项目 + 本主题，各带 GitHub 链接。
 *
 * 由后端作者提出，两条都放到每一页的最下面。链接写死在这里而不是走后台配置：
 * 这是「这套面板由什么构成」的事实，不是站长可配置的展示项。
 */

const BACKEND_REPO_URL = "https://github.com/huilang-me/CF-Server-Monitor";
const THEME_REPO_URL = "https://github.com/volcano-1025/CFSM-Theme-LuminaPlus";

export function SiteFooter() {
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
      </span>
    </footer>
  );
}
