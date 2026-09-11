import { describe, expect, it } from "vitest";
import { listAvailablePingTaskIds } from "@/hooks/usePingOverview";
import type { PingLiveSample } from "@/services/pingLiveStore";
import { EMPTY_CARRIER_PING } from "@/types/cfsm";
import {
  EMPTY_PING_LINE_OVERRIDES,
  normalizePingLineOverrides,
  resolveNodePingLineTaskIds,
  switchPingLine,
} from "@/utils/pingLineOverrides";

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
