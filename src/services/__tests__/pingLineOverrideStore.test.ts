// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "cfsm-luminaplus:ping-line-overrides";

// store 有模块级缓存：重新求值模块 = 刷新页面，只剩 localStorage 里的内容。
async function loadStore() {
  vi.resetModules();
  return import("@/services/pingLineOverrideStore");
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("pingLineOverrideStore", () => {
  it("persists per-node overrides across a reload", async () => {
    const store = await loadStore();
    store.setPingLineOverrides("node-a", { "0": 4 });

    const reloaded = await loadStore();
    expect(reloaded.getPingLineOverrides("node-a")).toEqual({ "0": 4 });
    expect(reloaded.getPingLineOverrides("node-b")).toEqual({});
  });

  it("removes the node, and the storage key once nothing is left, on reset", async () => {
    const store = await loadStore();
    store.setPingLineOverrides("node-a", { "0": 4 });
    store.setPingLineOverrides("node-a", {});

    expect(store.getPingLineOverrides("node-a")).toEqual({});
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("ignores corrupted payloads, unknown line ids and prototype keys", async () => {
    window.localStorage.setItem(STORAGE_KEY, "{ not json");
    expect((await loadStore()).getPingLineOverrides("node-a")).toEqual({});

    window.localStorage.setItem(
      STORAGE_KEY,
      '{"node-a":{"0":99,"1":5},"node-b":[4],"__proto__":{"0":4}}',
    );
    const store = await loadStore();
    expect(store.getPingLineOverrides("node-a")).toEqual({ "1": 5 });
    expect(store.getPingLineOverrides("node-b")).toEqual({});
    expect(store.getPingLineOverrides("constructor")).toEqual({});
  });

  it("keeps other nodes' snapshots referentially stable, so their cards do not re-render", async () => {
    const store = await loadStore();
    store.setPingLineOverrides("node-a", { "0": 4 });
    store.setPingLineOverrides("node-b", { "1": 5 });
    const before = store.getPingLineOverrides("node-a");

    store.setPingLineOverrides("node-b", { "1": 6 });
    expect(store.getPingLineOverrides("node-a")).toBe(before);
    expect(store.getPingLineOverrides("node-b")).toEqual({ "1": 6 });
  });

  it("notifies subscribers only when something actually changes", async () => {
    const store = await loadStore();
    let calls = 0;
    const unsubscribe = store.subscribePingLineOverrides(() => {
      calls += 1;
    });

    store.setPingLineOverrides("node-a", { "0": 4 });
    store.setPingLineOverrides("node-a", { "0": 4 });
    store.setPingLineOverrides("node-b", {});
    unsubscribe();
    store.setPingLineOverrides("node-a", {});

    expect(calls).toBe(1);
  });

  it("lists every node and clears them all at once (保存到后端之后)", async () => {
    const store = await loadStore();
    store.setPingLineOverrides("node-a", { "0": 4 });
    store.setPingLineOverrides("node-b", { "1": 5 });
    expect(store.getAllPingLineOverrides()).toEqual({
      "node-a": { "0": 4 },
      "node-b": { "1": 5 },
    });

    let calls = 0;
    const unsubscribe = store.subscribePingLineOverrides(() => {
      calls += 1;
    });
    store.clearPingLineOverrides();
    store.clearPingLineOverrides();
    unsubscribe();

    expect(store.getAllPingLineOverrides()).toEqual({});
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(calls).toBe(1);
  });
});
