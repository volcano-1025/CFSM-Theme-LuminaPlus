import { describe, expect, it } from "vitest";
import { CARRIER_TASKS } from "@/services/cfsm/mappers";
import {
  DEFAULT_HOMEPAGE_PING_TASK_ID,
  HOMEPAGE_MULTI_PING_MAX_COUNT,
  assignHomepageMultiPingTask,
  resolveDefaultHomepagePingTaskId,
  isHomepageMultiPingConfigured,
  normalizeHomepageMultiPingTaskIds,
  invertHomepagePingTaskBindings,
  hasHomepagePingTaskBinding,
  normalizeHomepagePingTaskBindings,
  resolveHomepagePingSelections,
  resolveHomepagePingTaskIdsByClient,
  orderTasksByCardLines,
} from "@/utils/pingTasks";

describe("homepage ping task bindings", () => {
  it("accepts only positive decimal safe integers", () => {
    expect(
      normalizeHomepagePingTaskBindings({
        "1e3": ["exponent"],
        "1.5": ["fraction"],
        "0x10": ["hex"],
        "9007199254740992": ["unsafe"],
        "42": ["valid"],
      }),
    ).toEqual({ "42": ["valid"] });
  });

  it("merges IDs that normalize to the same decimal integer", () => {
    expect(
      normalizeHomepagePingTaskBindings({
        "01": ["node-a", "node-b"],
        "1": ["node-b", "node-c"],
      }),
    ).toEqual({ "1": ["node-b", "node-c", "node-a"] });
  });

  it("inverts normalized bindings and gives the lowest task ID precedence", () => {
    expect(
      invertHomepagePingTaskBindings({
        "02": ["node-a"],
        "1": ["node-a", "node-b"],
      }),
    ).toEqual(
      new Map([
        ["node-a", 1],
        ["node-b", 1],
      ]),
    );
  });

  it("reuses the inverted binding index for a stable bindings object", () => {
    const bindings = { "8": ["node-a"], "9": ["node-b"] };
    expect(invertHomepagePingTaskBindings(bindings)).toBe(
      invertHomepagePingTaskBindings(bindings),
    );
  });

  it("reports a binding before overview data has loaded", () => {
    const bindings = { "8": ["node-a"], "9": ["node-b"] };
    expect(hasHomepagePingTaskBinding("node-a", bindings)).toBe(true);
    expect(hasHomepagePingTaskBinding("node-c", bindings)).toBe(false);
  });

  it("normalizes the global selection in display order, capped at the max line count", () => {
    // 去重、保序、按上限截断。上限跟着后端线路数走（2.8.5 Beta4 起是八条），不再写死三条。
    expect(normalizeHomepageMultiPingTaskIds(["3", 1, 3, 2, 4])).toEqual([3, 1, 2, 4]);
    expect(normalizeHomepageMultiPingTaskIds([8, 7, 6, 5, 4, 3, 2, 1, 9])).toEqual([
      8, 7, 6, 5, 4, 3, 2, 1,
    ]);
  });

  it("swaps two slots when the picked line is already used by another slot", () => {
    // 线路 1 选了线路 3 正在用的「移动」：两条互换，不会出现两条都是移动。
    expect(assignHomepageMultiPingTask([1, 2, 3], 0, 3)).toEqual([3, 2, 1]);
    // 选一条没在用的：只换这一格。
    expect(assignHomepageMultiPingTask([1, 2, 3], 1, 5)).toEqual([1, 5, 3]);
  });

  it("leaves the selection alone for a no-op pick or a slot that does not exist", () => {
    const taskIds = [1, 2, 3];
    expect(assignHomepageMultiPingTask(taskIds, 2, 3)).toEqual([1, 2, 3]);
    expect(assignHomepageMultiPingTask(taskIds, 3, 5)).toEqual([1, 2, 3]);
    expect(assignHomepageMultiPingTask(taskIds, -1, 5)).toEqual([1, 2, 3]);
    // 返回的是拷贝，不改调用方的数组。
    expect(assignHomepageMultiPingTask(taskIds, 0, 3)).not.toBe(taskIds);
    expect(taskIds).toEqual([1, 2, 3]);
  });

  it("treats any non-empty selection as configured (1 line is valid)", () => {
    expect(isHomepageMultiPingConfigured([1])).toBe(true);
    expect(isHomepageMultiPingConfigured([1, 2, 3, 4])).toBe(true);
    expect(isHomepageMultiPingConfigured([])).toBe(false);
  });

  it("keeps the max line count aligned with the carrier lines the backend actually has", () => {
    // 后端以后加线路（CARRIER_TASKS 变长），这条会先失败，提醒把上限一起抬上去。
    expect(HOMEPAGE_MULTI_PING_MAX_COUNT).toBe(CARRIER_TASKS.length);
  });

  it("falls unbound nodes back to the site's default line, not a hardcoded 电信", () => {
    // 全站绑联通(2)的站点新加一台节点：默认线路设成 2 时它就跟着走 2，而不是写死的 1。
    expect(
      resolveHomepagePingTaskIdsByClient(["new-node"], { "2": ["old-node"] }, [], 2),
    ).toEqual(new Map([["new-node", [2]]]));
    // 单独绑过的节点仍以绑定为准，默认线路管不着它。
    expect(
      resolveHomepagePingTaskIdsByClient(["old-node"], { "3": ["old-node"] }, [], 2),
    ).toEqual(new Map([["old-node", [3]]]));
  });

  it("keeps 电信 as the fallback when the default line is unset or invalid", () => {
    for (const bad of [undefined, null, 0, -1, 1.5, "2", Number.NaN]) {
      expect(resolveDefaultHomepagePingTaskId(bad)).toBe(DEFAULT_HOMEPAGE_PING_TASK_ID);
    }
    expect(resolveDefaultHomepagePingTaskId(4)).toBe(4);
  });

  it("uses the selected lines for every node whatever the count", () => {
    expect(
      resolveHomepagePingTaskIdsByClient(["node-a"], { "8": ["node-a"] }, [2]),
    ).toEqual(new Map([["node-a", [2]]]));
    expect(
      resolveHomepagePingTaskIdsByClient(["node-a"], {}, [4, 1]),
    ).toEqual(new Map([["node-a", [4, 1]]]));
  });

  it("uses the same three global tasks for every node and otherwise keeps single bindings", () => {
    const bindings = { "8": ["node-a"], "9": ["node-b"] };
    expect(
      resolveHomepagePingTaskIdsByClient(["node-a", "node-b"], bindings, [3, 1, 2]),
    ).toEqual(
      new Map([
        ["node-a", [3, 1, 2]],
        ["node-b", [3, 1, 2]],
      ]),
    );
    expect(resolveHomepagePingTaskIdsByClient(["node-a", "node-b"], bindings)).toEqual(
      new Map([
        ["node-a", [8]],
        ["node-b", [9]],
      ]),
    );
  });

  it("requests either global multi-ping tasks or per-node single bindings, never both", () => {
    const multiSelections = resolveHomepagePingSelections(
      ["node-a", "node-b"],
      { "8": ["node-a"], "9": ["node-b"] },
      [3, 1, 2],
    );

    expect(multiSelections.singleTaskIdsByClient).toEqual(new Map());
    expect(multiSelections.multiTaskIdsByClient).toEqual(
      new Map([
        ["node-a", [3, 1, 2]],
        ["node-b", [3, 1, 2]],
      ]),
    );
    expect(multiSelections.requestedTaskIdsByClient).toBe(
      multiSelections.multiTaskIdsByClient,
    );

    const singleSelections = resolveHomepagePingSelections(
      ["node-a", "node-b"],
      { "8": ["node-a"], "9": ["node-b"] },
    );
    expect(singleSelections.singleTaskIdsByClient).toEqual(
      new Map([
        ["node-a", [8]],
        ["node-b", [9]],
      ]),
    );
    expect(singleSelections.multiTaskIdsByClient).toEqual(new Map());
    expect(singleSelections.requestedTaskIdsByClient).toBe(
      singleSelections.singleTaskIdsByClient,
    );
  });
});

describe("orderTasksByCardLines", () => {
  const tasks = [1, 2, 3, 4, 5].map((id) => ({ id }));

  it("puts the card's lines first in the card's order, the rest keep their order", () => {
    expect(orderTasksByCardLines(tasks, [3, 1, 2]).map((task) => task.id)).toEqual([3, 1, 2, 4, 5]);
    expect(orderTasksByCardLines(tasks, [5, 2]).map((task) => task.id)).toEqual([5, 2, 1, 3, 4]);
  });

  it("ignores card lines the chart has no data for and keeps the order without a card order", () => {
    expect(orderTasksByCardLines(tasks, [8, 2]).map((task) => task.id)).toEqual([2, 1, 3, 4, 5]);
    expect(orderTasksByCardLines(tasks, []).map((task) => task.id)).toEqual([1, 2, 3, 4, 5]);
  });
});
