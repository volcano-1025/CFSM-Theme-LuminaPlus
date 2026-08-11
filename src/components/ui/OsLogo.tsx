import { memo, useState } from "react";
import { hostAssetUrl } from "@/services/cfsm/config";

interface OsConfig {
  name: string;
  image: string;
  keywords: string[];
}

const OS_NAME_SPLIT_REGEX = /[\s/]+/;

/**
 * OS 图标走后端默认皮肤的静态文件，主题不打包（见 theme-develop.md）。
 * 下面 `image` 里只记文件名，必须存在于后端 `public/os-icons/`；没有对应图标的系统
 * 统一落到 os-unknown。URL 在渲染时才拼，模块初始化阶段不依赖 window。
 */
function osIconUrl(file: string) {
  return hostAssetUrl(`/os-icons/${file}`);
}

const OS_CONFIGS: OsConfig[] = [
  {
    name: "AlmaLinux",
    image: "os-alma.svg",
    keywords: ["alma", "almalinux"],
  },
  {
    name: "Alpine Linux",
    image: "os-alpine.webp",
    keywords: ["alpine", "alpine linux"],
  },
  {
    name: "Armbian",
    image: "os-armbian.png",
    keywords: ["armbian"],
  },
  {
    name: "CentOS",
    image: "os-centos.svg",
    keywords: ["centos", "cent os"],
  },
  {
    name: "Debian",
    image: "os-debian.svg",
    keywords: ["debian", "deb"],
  },
  {
    name: "FreeBSD",
    image: "os-unknown.svg",
    keywords: ["freebsd", "bsd"],
  },
  {
    name: "Ubuntu",
    image: "os-ubuntu.svg",
    keywords: ["ubuntu", "elementary"],
  },
  {
    name: "Windows",
    image: "os-windows.svg",
    keywords: ["windows", "win", "microsoft", "ms"],
  },
  {
    name: "Arch Linux",
    image: "os-arch.svg",
    keywords: ["arch", "archlinux", "arch linux"],
  },
  {
    name: "Kali Linux",
    image: "os-kail.svg",
    keywords: ["kail", "kali", "kali linux"],
  },
  {
    name: "iStoreOS",
    image: "os-istore.png",
    keywords: ["istore", "istoreos", "istore os"],
  },
  {
    name: "OpenWrt",
    image: "os-openwrt.svg",
    keywords: ["openwrt", "open wrt", "open-wrt", "qwrt"],
  },
  {
    name: "ImmortalWrt",
    image: "os-openwrt.svg",
    keywords: ["immortalwrt", "immortal", "emmortal"],
  },
  {
    name: "NixOS",
    image: "os-nix.svg",
    keywords: ["nixos", "nix os", "nix"],
  },
  {
    name: "Rocky Linux",
    image: "os-rocky.svg",
    keywords: ["rocky", "rocky linux"],
  },
  {
    name: "Fedora",
    image: "os-fedora.svg",
    keywords: ["fedora"],
  },
  {
    name: "openSUSE",
    image: "os-openSUSE.svg",
    keywords: ["opensuse", "suse"],
  },
  {
    name: "Gentoo",
    image: "os-gentoo.svg",
    keywords: ["gentoo"],
  },
  {
    name: "Red Hat",
    image: "os-redhat.svg",
    keywords: ["redhat", "rhel", "red hat"],
  },
  {
    name: "Linux Mint",
    image: "os-mint.svg",
    keywords: ["mint", "linux mint"],
  },
  {
    name: "Manjaro",
    image: "os-manjaro-.svg",
    keywords: ["manjaro"],
  },
  {
    name: "Synology DSM",
    image: "os-synology.ico",
    keywords: ["synology", "dsm", "synology dsm"],
  },
  {
    name: "fnOS",
    image: "os-unknown.svg",
    keywords: ["fnos", "fnnas"],
  },
  {
    name: "Proxmox VE",
    image: "os-proxmox.ico",
    keywords: ["proxmox", "proxmox ve"],
  },
  {
    name: "macOS",
    image: "os-macos.svg",
    keywords: ["macos", "mac os", "mac os x", "osx", "darwin"],
  },
  {
    name: "QTS",
    image: "os-unknown.svg",
    keywords: ["qts", "quts hero", "qes", "qutscloud"],
  },
  {
    name: "Astra Linux",
    image: "os-unknown.svg",
    keywords: ["astra", "astra linux"],
  },
  {
    name: "Orange Pi",
    image: "os-unknown.svg",
    keywords: ["orange pi", "orangepi"],
  },
  {
    name: "Huawei",
    image: "os-unknown.svg",
    keywords: ["huawei", "euleros", "euler os"],
  },
  {
    name: "Aliyun",
    image: "os-alibaba.svg",
    keywords: ["aliyun", "alibaba"],
  },
  {
    name: "OpenCloudOS",
    image: "os-opencloud.svg",
    keywords: ["opencloud"],
  },
  {
    name: "Unraid",
    image: "os-unknown.svg",
    keywords: ["unraid"],
  },
];

const DEFAULT_OS_CONFIG: OsConfig = {
  name: "Linux",
  image: "os-unknown.svg",
  keywords: ["unknown"],
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const OS_MATCHERS = OS_CONFIGS.map((config) => ({
  config,
  matcher: new RegExp(`\\b(?:${config.keywords.map(escapeRegExp).join("|")})\\b`),
}));

function findOsConfig(osString?: string | null): OsConfig {
  if (!osString) {
    return DEFAULT_OS_CONFIG;
  }

  const normalizedInput = osString.toLowerCase().trim();
  for (const { config, matcher } of OS_MATCHERS) {
    if (matcher.test(normalizedInput)) {
      return config;
    }
  }

  return DEFAULT_OS_CONFIG;
}

export function resolveOsInfo(value?: string | null) {
  const config = findOsConfig(value);
  if (config !== DEFAULT_OS_CONFIG) {
    return config;
  }

  const name = value?.trim().split(OS_NAME_SPLIT_REGEX)[0] || DEFAULT_OS_CONFIG.name;
  return {
    ...DEFAULT_OS_CONFIG,
    name,
  };
}

export const OsLogo = memo(function OsLogo({
  value,
  size = 18,
}: {
  value?: string | null;
  size?: number;
}) {
  const os = resolveOsInfo(value);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const file = failedImage === os.image ? DEFAULT_OS_CONFIG.image : os.image;
  const src = osIconUrl(file);

  return (
    <img
      className="os-logo"
      src={src}
      alt={os.name}
      title={os.name}
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => {
        if (file !== DEFAULT_OS_CONFIG.image) setFailedImage(os.image);
      }}
      style={{ "--os-logo-size": `${size}px` } as React.CSSProperties}
    />
  );
});
