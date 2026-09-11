import { describe, expect, it } from "vitest";
import { compareVersions, formatVersionLabel, isNewerVersion } from "@/utils/versionCompare";

describe("compareVersions", () => {
  it("compares numeric segments, padding the shorter one with zeros", () => {
    expect(compareVersions("1.2.15", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("v1.2.15", "1.2.15")).toBe(0);
  });

  it("ranks a pre-release below the release with the same number (backend style)", () => {
    expect(compareVersions("2.8.5 Beta5", "2.8.5")).toBeLessThan(0);
    expect(compareVersions("2.8.5 Beta6", "2.8.5 Beta5")).toBeGreaterThan(0);
    expect(compareVersions("2.8.5-rc.1", "2.8.5 Beta9")).toBeGreaterThan(0);
    expect(compareVersions("2.8.6 Beta1", "2.8.5")).toBeGreaterThan(0);
  });

  it("returns null when either side cannot be read", () => {
    expect(compareVersions("latest", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", "")).toBeNull();
    expect(compareVersions(null, "1.0.0")).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("only says yes for a strictly newer, readable version", () => {
    expect(isNewerVersion("2.8.6", "2.8.5 Beta5")).toBe(true);
    expect(isNewerVersion("2.8.5 Beta5", "2.8.5 Beta5")).toBe(false);
    // 本地跑的比远端还新（开发版）不能报「有新版」。
    expect(isNewerVersion("2.8.5", "2.8.6 Beta1")).toBe(false);
    expect(isNewerVersion("something new", "2.8.5")).toBe(false);
  });
});

describe("formatVersionLabel", () => {
  it("adds a single v prefix", () => {
    expect(formatVersionLabel("2.8.5 Beta5")).toBe("v2.8.5 Beta5");
    expect(formatVersionLabel("v1.2.15")).toBe("v1.2.15");
  });
});
