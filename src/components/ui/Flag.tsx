import { useState } from "react";
import { hostAssetUrl } from "@/services/cfsm/config";
import { getDisplayRegionCode } from "@/utils/geo";

interface FlagProps {
  region?: string | null;
  size?: number;
}

export function Flag({ region, size = 14 }: FlagProps) {
  const value = region?.trim() ?? "";
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!value) {
    return (
      <span
        aria-hidden
        className="inline-block rounded-[3px] shrink-0"
        style={{
          width: size + 8,
          height: size,
          background: "var(--border-subtle)",
        }}
      />
    );
  }

  const flagCode = getDisplayRegionCode(value);
  // 旗帜由后端默认皮肤提供，主题不打包（见 theme-develop.md 的主题构建产物约定）。
  // 后端的文件名是小写的。
  const src = hostAssetUrl(`/flags/${flagCode.toLowerCase()}.svg`);
  const alt = `地区旗帜: ${flagCode}`;

  if (failedSrc === src) {
    return (
      <span
        role="img"
        aria-label={alt}
        className="inline-block rounded-[3px] shrink-0"
        title={alt}
        style={{
          width: size + 8,
          height: size,
          background: "var(--border-subtle)",
        }}
      />
    );
  }

  return (
    <span
      className="inline-flex items-center shrink-0"
      style={{
        width: size + 8,
        height: size,
        lineHeight: 0,
      }}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
        }}
        onError={() => setFailedSrc(src)}
      />
    </span>
  );
}
