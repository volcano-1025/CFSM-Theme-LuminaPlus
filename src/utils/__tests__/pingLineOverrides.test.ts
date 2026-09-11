import { describe, expect, it } from "vitest";
import { listAvailablePingTaskIds } from "@/hooks/usePingOverview";
import type { PingLiveSample } from "@/services/pingLiveStore";
import { EMPTY_CARRIER_PING } from "@/types/cfsm";
import {
  EMPTY_PING_LINE_OVERRIDES,
  EMPTY_PING_LINE_OVERRIDES_BY_NODE,
  mergePingLineOverridesByNode,
  nodePingLineOverrides,
  normalizePingLineOverrides,
  normalizePingLineOverridesByNode,
  resolveNodePingLineTaskIds,
  switchPingLine,
} from "@/utils/pingLineOverrides";
import { normalizeThemeSettings } from "@/utils/themeSettings";

describe("normalizePingLineOverrides", () => {
  it("keeps canonical row keys within the line limit and positive task ids only", () => {
    expect(
      normalizePingLineOverrides({
        "0": 4,
        "01": 5,
        "-1": 5,
        "1.5": 5,
        "2": 0,
        "3": "4",
        "8": 4,
        "1": 6,
      }),
    ).toEqual({ "0": 4, "1": 6 });
  });

  it("drops task ids the caller does not know", () => {
    expect(normalizePingLineOverrides({ "0": 4, "1": 99 }, (id) => id <= 8)).toEqual({
      "0": 4,
    });
  });

  it("returns the shared empty table for junk", () => {
    for (const junk of [null, undefined, [], "x", 3, {}, { "0": null }]) {
      expect(normalizePingLineOverrides(junk)).toBe(EMPTY_PING_LINE_OVERRIDES);
    }
  });
});

describe("resolveNodePingLineTaskIds", () => {
  it("returns the site list itself when nothing takes effect", () => {
    const site = [1, 2, 3];
    expect(resolveNodePingLineTaskIds(site, EMPTY_PING_LINE_OVERRIDES)).toBe(site);
    expect(resolveNodePingLineTaskIds(site, { "1": 2 })).toBe(site);
  });

  it("replaces only the switched rows; untouched rows follow later site changes", () => {
    expect(resolveNodePingLineTaskIds([1, 2, 3], { "0": 4 })).toEqual([4, 2, 3]);
    // 站长后来把第 2、3 行改成了别的线路，访客只换过第 1 行。
    expect(resolveNodePingLineTaskIds([1, 5, 6], { "0": 4 })).toEqual([4, 5, 6]);
  });

  it("ignores rows beyond the site's current line count", () => {
    const site = [1, 2];
    expect(resolveNodePingLineTaskIds(site, { "2": 4 })).toBe(site);
  });

  it("falls back to the site list when an override would show a line twice", () => {
    // 访客把第 1 行换成 BD；后来站长把 BD 排进了第 2 行。
    const site = [1, 4, 3];
    expect(resolveNodePingLineTaskIds(site, { "0": 4 })).toBe(site);
  });
});

describe("switchPingLine", () => {
  const site = [1, 2, 3];

  it("records a replaced row", () => {
    expect(switchPingLine(site, EMPTY_PING_LINE_OVERRIDES, 0, 4)).toEqual({ "0": 4 });
  });

  it("swaps two rows when the chosen line is already shown in another row", () => {
    const next = switchPingLine(site, EMPTY_PING_LINE_OVERRIDES, 0, 3);
    expect(next).toEqual({ "0": 3, "2": 1 });
    expect(resolveNodePingLineTaskIds(site, next)).toEqual([3, 2, 1]);
  });

  it("ends with the empty table once every row is back on the site's line", () => {
    const replaced = switchPingLine(site, EMPTY_PING_LINE_OVERRIDES, 0, 4);
    expect(switchPingLine(site, replaced, 0, 1)).toBe(EMPTY_PING_LINE_OVERRIDES);

    const swapped = switchPingLine(site, EMPTY_PING_LINE_OVERRIDES, 0, 3);
    expect(switchPingLine(site, swapped, 0, 1)).toBe(EMPTY_PING_LINE_OVERRIDES);
  });

  it("is a no-op for the current line or a row that does not exist", () => {
    const current = { "0": 4 };
    expect(switchPingLine(site, current, 0, 4)).toBe(current);
    expect(switchPingLine(site, current, 3, 5)).toBe(current);
    expect(switchPingLine(site, current, -1, 5)).toBe(current);
    expect(switchPingLine(site, current, 1, 0)).toBe(current);
  });

  it("drops stale rows when switching again", () => {
    expect(switchPingLine([1, 2], { "0": 5, "2": 4 }, 1, 6)).toEqual({ "0": 5, "1": 6 });
  });
});

describe("listAvailablePingTaskIds", () => {
  const sample = (time: number, values: Partial<PingLiveSample["ping"]>): PingLiveSample => ({
    time,
    ping: { ...EMPTY_CARRIER_PING, ...values },
  });

  it("lists lines with at least one value (failed probes count) in carrier-table order", () => {
    const samples = [sample(1, { cu: 30, node_2: 12 }), sample(2, { ct: -1, cu: 31 })];
    expect(listAvailablePingTaskIds(samples)).toEqual([1, 2, 6]);
  });

  it("returns the same array for the same buffer", () => {
    const samples = [sample(1, { ct: 30 })];
    expect(listAvailablePingTaskIds(samples)).toBe(listAvailablePingTaskIds(samples));
    expect(listAvailablePingTaskIds([])).toEqual([]);
  });
});

describe("normalizePingLineOverridesByNode", () => {
  it("keeps valid nodes and drops empty or junk ones", () => {
    expect(
      normalizePingLineOverridesByNode({
        "node-a": { "0": 4, "9": 5 },
        "node-b": { "0": 0 },
        "node-c": [4],
        "": { "0": 4 },
      }),
    ).toEqual({ "node-a": { "0": 4 } });
  });

  it("returns the shared empty map for junk", () => {
    for (const junk of [null, undefined, [], "x", {}]) {
      expect(normalizePingLineOverridesByNode(junk)).toBe(EMPTY_PING_LINE_OVERRIDES_BY_NODE);
    }
  });

  it("survives the theme settings snapshot round trip (保存到后端 / 复制配置 JSON)", () => {
    const snapshot = normalizeThemeSettings({
      homepagePingLineOverrides: { "node-a": { "0": 4 } },
    } as never);
    expect(snapshot.homepagePingLineOverrides).toEqual({ "node-a": { "0": 4 } });
    expect(normalizeThemeSettings(JSON.parse(JSON.stringify(snapshot)) as never)).toEqual(snapshot);
    expect(normalizeThemeSettings(null).homepagePingLineOverrides).toEqual({});
  });
});

describe("mergePingLineOverridesByNode", () => {
  const site = [1, 2, 3];

  it("adds rows switched on this device to the saved ones, device rows winning", () => {
    expect(
      mergePingLineOverridesByNode(
        site,
        { "node-a": { "0": 4 }, "node-b": { "1": 5 } },
        { "node-a": { "2": 6 }, "node-b": { "1": 7 } },
      ),
    ).toEqual({ "node-a": { "0": 4, "2": 6 }, "node-b": { "1": 7 } });
  });

  it("removes a saved row the device switched back to the site's line", () => {
    // 站点存过第 1 行 BGP；站长在卡片上又换回电信（本机表相对「站点那份」算，记成 {0: 1}）。
    expect(
      mergePingLineOverridesByNode(site, { "node-a": { "0": 4 } }, { "node-a": { "0": 1 } }),
    ).toEqual({});
  });

  it("keeps a swap made on top of saved rows", () => {
    // 站点存过 [4,2,3]；本机把第 1、2 行互换 → 显示 [2,4,3]。
    const local = { "node-a": switchPingLine([4, 2, 3], EMPTY_PING_LINE_OVERRIDES, 0, 2) };
    const merged = mergePingLineOverridesByNode(site, { "node-a": { "0": 4 } }, local);
    expect(resolveNodePingLineTaskIds(site, nodePingLineOverrides(merged, "node-a"))).toEqual([
      2, 4, 3,
    ]);
  });

  it("drops rows beyond the line count and nodes that would not take effect", () => {
    expect(
      mergePingLineOverridesByNode([1, 2], {}, { "node-a": { "2": 4 }, "node-b": { "0": 2 } }),
    ).toBe(EMPTY_PING_LINE_OVERRIDES_BY_NODE);
  });

  it("does not let stale saved rows swallow a fresh switch", () => {
    // 站点存的 {0: 4} 撞上后来改成 [1,4,3] 的线路表（重复 → 不生效）；本机只换了第 3 行。
    expect(
      mergePingLineOverridesByNode([1, 4, 3], { "node-a": { "0": 4 } }, { "node-a": { "2": 5 } }),
    ).toEqual({ "node-a": { "2": 5 } });
  });
});
