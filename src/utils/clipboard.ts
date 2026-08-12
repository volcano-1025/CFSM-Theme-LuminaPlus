/**
 * 复制文本到剪贴板。
 *
 * `navigator.clipboard` 只在 https / localhost 下可用，纯 http 部署的站点必须退回
 * `execCommand("copy")`，否则「复制配置」按钮在这些站点上永远失败。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或不在安全上下文，走下面的兜底。
  }

  if (typeof document === "undefined") return false;
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // 不能用 display:none / visibility:hidden，那样选不中也就复制不了。
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
