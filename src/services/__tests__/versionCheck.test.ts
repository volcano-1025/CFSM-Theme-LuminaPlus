// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 11, 12, 0);
const RELEASE_HTML =
  '<!doctype html><html><head>\n  <meta name="theme-version" content="LuminaPlus v1.2.16" />\n  </head></html>';

// 模块有缓存：每条用例重新求值，等于刷新页面。
async function loadModule() {
  vi.resetModules();
  return import("@/services/versionCheck");
}

function reply(html: string, ok = true) {
  return { ok, text: async () => html } as unknown as Response;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
});

describe("theme version parsing", () => {
  it("reads the version out of the build meta, both on this page and in the release html", async () => {
    const { extractThemeVersionFromHtml, parseThemeVersionMeta, readCurrentThemeVersion } =
      await loadModule();

    expect(parseThemeVersionMeta("LuminaPlus v1.2.15")).toBe("1.2.15");
    expect(parseThemeVersionMeta("LuminaPlus")).toBeNull();
    expect(extractThemeVersionFromHtml(RELEASE_HTML)).toBe("1.2.16");

    document.head.innerHTML = '<meta name="theme-version" content="LuminaPlus v1.2.15" />';
    expect(readCurrentThemeVersion()).toBe("1.2.15");
  });
});

describe("fetchLatestThemeVersion", () => {
  it("asks GitHub once, then serves the answer from the local cache for 12 hours", async () => {
    const fetchMock = vi.fn(async () => reply(RELEASE_HTML));
    vi.stubGlobal("fetch", fetchMock);

    const first = await loadModule();
    expect(await first.fetchLatestThemeVersion(NOW)).toBe("1.2.16");

    // 刷新页面也不再查。
    const reloaded = await loadModule();
    expect(await reloaded.fetchLatestThemeVersion(NOW + 11 * HOUR)).toBe("1.2.16");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await reloaded.fetchLatestThemeVersion(NOW + 13 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off for an hour after a failure and keeps the last known version meanwhile", async () => {
    const fetchMock = vi.fn(async () => reply(RELEASE_HTML));
    vi.stubGlobal("fetch", fetchMock);
    const module = await loadModule();
    await module.fetchLatestThemeVersion(NOW);

    fetchMock.mockImplementation(async () => {
      throw new Error("offline");
    });
    expect(await module.fetchLatestThemeVersion(NOW + 13 * HOUR)).toBe("1.2.16");
    expect(await module.fetchLatestThemeVersion(NOW + 13.5 * HOUR)).toBe("1.2.16");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await module.fetchLatestThemeVersion(NOW + 14.5 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
