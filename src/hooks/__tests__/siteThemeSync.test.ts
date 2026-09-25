// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSiteThemeSyncStatus,
  hasUnsyncedLocalChanges,
  resetSiteThemeSyncForTest,
  retrySiteThemeSync,
  SITE_THEME_SYNC_DEBOUNCE_MS,
  startSiteThemeAutoSync,
} from "@/hooks/useSiteThemeOptions";
import { ApiRequestError } from "@/services/cfsm/http";
import {
  clearPingLineOverrides,
  getAllPingLineOverrides,
  setPingLineOverrides,
} from "@/services/pingLineOverrideStore";
import { queryClient } from "@/services/queryClient";
import {
  getLocalThemeSettings,
  resetLocalThemeSettings,
  saveLocalThemeSettings,
} from "@/services/themeSettingsStore";
import type { PublicConfig } from "@/types/cfsm";

const mocks = vi.hoisted(() => ({
  saveThemeOptions: vi.fn(),
  getPublic: vi.fn(),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    saveThemeOptions: (...args: unknown[]) => mocks.saveThemeOptions(...args),
    getPublic: (...args: unknown[]) => mocks.getPublic(...args),
  };
});

const PENDING_KEY = "cfsm-luminaplus:site-sync-pending";

function seedConfig(themeSettings: Record<string, unknown> = {}) {
  queryClient.setQueryData<PublicConfig>(["public"], {
    theme_settings: themeSettings,
  } as PublicConfig);
}

function siteSettings() {
  return queryClient.getQueryData<PublicConfig>(["public"])?.theme_settings;
}

/** 后端照单全收，回的就是提交的那份。 */
function acceptWrites() {
  mocks.saveThemeOptions.mockImplementation((themeOptions: Record<string, unknown>) =>
    Promise.resolve({ success: true, theme_options: themeOptions, message: "" }),
  );
}

async function flushDebounce() {
  await vi.advanceTimersByTimeAsync(SITE_THEME_SYNC_DEBOUNCE_MS);
}

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  resetLocalThemeSettings();
  clearPingLineOverrides();
  resetSiteThemeSyncForTest();
  queryClient.clear();
  mocks.saveThemeOptions.mockReset();
  mocks.getPublic.mockReset();
  // 默认后端和缓存里的是同一份；要模拟「别的设备改过」的用例自己换掉。
  mocks.getPublic.mockImplementation(() =>
    Promise.resolve(queryClient.getQueryData<PublicConfig>(["public"])),
  );
  window.localStorage.setItem("jwt_token", "token");
  seedConfig();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  window.localStorage.clear();
  resetLocalThemeSettings();
  clearPingLineOverrides();
  resetSiteThemeSyncForTest();
  queryClient.clear();
});

describe("登录站长的改动自动同步到后端", () => {
  it("停手后只发一次，发完以后端为准、本机清空", async () => {
    acceptWrites();
    stop = startSiteThemeAutoSync();

    saveLocalThemeSettings({ desktopNodeViewMode: "compact" });
    await vi.advanceTimersByTimeAsync(SITE_THEME_SYNC_DEBOUNCE_MS / 2);
    saveLocalThemeSettings({ desktopNodeViewMode: "list" });
    expect(getSiteThemeSyncStatus().phase).toBe("pending");
    await flushDebounce();

    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(1);
    expect(mocks.saveThemeOptions.mock.calls[0][0]).toMatchObject({ desktopNodeViewMode: "list" });
    expect(siteSettings()).toMatchObject({ desktopNodeViewMode: "list" });
    expect(getLocalThemeSettings()).toEqual({});
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(getSiteThemeSyncStatus().phase).toBe("synced");
  });

  it("卡片上换线路也同步，换过的行并进站点配置", async () => {
    acceptWrites();
    seedConfig({ enableHomepageMultiPing: true, homepageMultiPingTaskIds: [1, 2, 3] });
    stop = startSiteThemeAutoSync();

    setPingLineOverrides("node-a", { "0": 4 });
    await flushDebounce();

    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(1);
    expect(siteSettings()).toMatchObject({ homepagePingLineOverrides: { "node-a": { "0": 4 } } });
    expect(getAllPingLineOverrides()).toEqual({});
  });

  it("发之前重拉 config 当底：别的设备改过的项不被这台的旧副本盖掉", async () => {
    acceptWrites();
    // 这台设备几小时前拿到的 config：透明度 100、多线路开着。
    seedConfig({ surfaceOpacity: 100, enableHomepageMultiPing: true });
    // 之后站长在别的设备上改成了透明度 50、关掉多线路。
    mocks.getPublic.mockResolvedValue({
      theme_settings: { surfaceOpacity: 50, enableHomepageMultiPing: false },
    } as unknown as PublicConfig);
    stop = startSiteThemeAutoSync();

    saveLocalThemeSettings({ desktopNodeViewMode: "list" });
    await flushDebounce();

    expect(mocks.getPublic).toHaveBeenCalledTimes(1);
    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(1);
    expect(mocks.saveThemeOptions.mock.calls[0][0]).toMatchObject({
      surfaceOpacity: 50,
      enableHomepageMultiPing: false,
      desktopNodeViewMode: "list",
    });
  });

  it("重拉 config 失败就不发，改动留在本机等重试", async () => {
    acceptWrites();
    const fetchConfig = mocks.getPublic.getMockImplementation();
    mocks.getPublic.mockRejectedValue(new ApiRequestError("bad gateway", 502, "/api/config"));
    stop = startSiteThemeAutoSync();

    saveLocalThemeSettings({ desktopNodeViewMode: "list" });
    await flushDebounce();
    // 5xx 按 queryClient 的默认规则重试一次，都失败才报错。
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.getPublic).toHaveBeenCalledTimes(2);
    expect(mocks.saveThemeOptions).not.toHaveBeenCalled();
    expect(getSiteThemeSyncStatus().phase).toBe("error");
    expect(getLocalThemeSettings()).toEqual({ desktopNodeViewMode: "list" });

    mocks.getPublic.mockImplementation(fetchConfig!);
    retrySiteThemeSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(1);
    expect(getLocalThemeSettings()).toEqual({});
  });

  it("未登录的访客只存本机，不发请求", async () => {
    window.localStorage.removeItem("jwt_token");
    stop = startSiteThemeAutoSync();

    saveLocalThemeSettings({ desktopNodeViewMode: "compact" });
    await flushDebounce();

    expect(mocks.saveThemeOptions).not.toHaveBeenCalled();
    expect(getLocalThemeSettings()).toEqual({ desktopNodeViewMode: "compact" });
  });

  it("令牌还在但登录校验判成未登录（过期），也不发", async () => {
    queryClient.setQueryData(["me"], { logged_in: false, username: "", uuid: "" });
    stop = startSiteThemeAutoSync();

    saveLocalThemeSettings({ desktopNodeViewMode: "compact" });
    await flushDebounce();

    expect(mocks.saveThemeOptions).not.toHaveBeenCalled();
  });

  it("请求途中又改：不并发，改动留在本机，等回来再发一轮", async () => {
    let resolveFirst: (() => void) | undefined;
    mocks.saveThemeOptions.mockImplementationOnce(
      (themeOptions: Record<string, unknown>) =>
        new Promise((resolve) => {
          resolveFirst = () => resolve({ success: true, theme_options: themeOptions, message: "" });
        }),
    );
    stop = startSiteThemeAutoSync();

    saveLocalThemeSettings({ desktopNodeViewMode: "compact" });
    await flushDebounce();
    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(1);

    let localWhenSecondSent: Record<string, unknown> | undefined;
    mocks.saveThemeOptions.mockImplementation((themeOptions: Record<string, unknown>) => {
      localWhenSecondSent = { ...getLocalThemeSettings() };
      return Promise.resolve({ success: true, theme_options: themeOptions, message: "" });
    });
    saveLocalThemeSettings({ desktopNodeViewMode: "list" });
    await flushDebounce();
    // 第一次还没回来：第二次不能先发出去，否则旧快照晚到会盖掉新的。
    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // 第一次发出去的是 compact，回来时本机已经是 list：不能清，要留给第二轮。
    expect(localWhenSecondSent).toEqual({ desktopNodeViewMode: "list" });

    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(2);
    expect(mocks.saveThemeOptions.mock.calls[1][0]).toMatchObject({ desktopNodeViewMode: "list" });
    expect(getLocalThemeSettings()).toEqual({});
    expect(getSiteThemeSyncStatus().phase).toBe("synced");
  });

  it("和站点现有的一样就不发，本机那份照样清掉", async () => {
    seedConfig({ desktopNodeViewMode: "list" });
    stop = startSiteThemeAutoSync();

    saveLocalThemeSettings({ desktopNodeViewMode: "list" });
    await flushDebounce();

    expect(mocks.saveThemeOptions).not.toHaveBeenCalled();
    expect(getLocalThemeSettings()).toEqual({});
    expect(getSiteThemeSyncStatus().phase).toBe("synced");
  });

  it("失败时改动留在本机、不自动重试，点重试再发", async () => {
    mocks.saveThemeOptions.mockRejectedValueOnce(
      new ApiRequestError("unauthorized", 401, "/api/theme_options"),
    );
    stop = startSiteThemeAutoSync();

    saveLocalThemeSettings({ desktopNodeViewMode: "compact" });
    await flushDebounce();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(1);
    expect(getSiteThemeSyncStatus().phase).toBe("error");
    expect(getLocalThemeSettings()).toEqual({ desktopNodeViewMode: "compact" });
    expect(window.localStorage.getItem(PENDING_KEY)).not.toBeNull();

    acceptWrites();
    retrySiteThemeSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(2);
    expect(getLocalThemeSettings()).toEqual({});
    expect(getSiteThemeSyncStatus().phase).toBe("synced");
  });

  it("上次没同步上的改动，下次打开接着发", async () => {
    acceptWrites();
    saveLocalThemeSettings({ desktopNodeViewMode: "compact" });
    window.localStorage.setItem(PENDING_KEY, "1");

    stop = startSiteThemeAutoSync();
    await flushDebounce();

    expect(mocks.saveThemeOptions).toHaveBeenCalledTimes(1);
    expect(getLocalThemeSettings()).toEqual({});
  });

  it("本机只有自动同步上线前存的旧设置时，打开页面不往后端推", async () => {
    saveLocalThemeSettings({ desktopNodeViewMode: "compact" });

    stop = startSiteThemeAutoSync();
    await flushDebounce();

    expect(mocks.saveThemeOptions).not.toHaveBeenCalled();
    expect(getLocalThemeSettings()).toEqual({ desktopNodeViewMode: "compact" });
  });
});

describe("hasUnsyncedLocalChanges（站长的「改用后端配置」什么时候出现）", () => {
  it("同步失败、改动留在本机时出现", () => {
    expect(hasUnsyncedLocalChanges({ hasLocalChanges: true, phase: "error", waiting: false })).toBe(true);
  });

  it("自动同步上线前存在本机的旧设置也算", () => {
    expect(hasUnsyncedLocalChanges({ hasLocalChanges: true, phase: "idle", waiting: false })).toBe(true);
  });

  it("正在同步时不出现，免得每改一次就闪一下", () => {
    for (const phase of ["pending", "saving"] as const) {
      expect(hasUnsyncedLocalChanges({ hasLocalChanges: true, phase, waiting: false })).toBe(false);
    }
    expect(hasUnsyncedLocalChanges({ hasLocalChanges: true, phase: "error", waiting: true })).toBe(false);
  });

  it("本机没有改动就不出现", () => {
    expect(hasUnsyncedLocalChanges({ hasLocalChanges: false, phase: "error", waiting: false })).toBe(false);
  });
});
