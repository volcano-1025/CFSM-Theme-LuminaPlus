import { CARRIER_TASK_BY_ID } from "@/services/cfsm/mappers";
import {
  EMPTY_PING_LINE_OVERRIDES,
  normalizePingLineOverrides,
  type PingLineOverrides,
} from "@/utils/pingLineOverrides";

/**
 * 访客在首页卡片上点线路名换过的线路（多线路模式），按节点 uuid 分开存在本机。
 *
 * 故意不进主题设置那份 localStorage（`themeSettingsStore`）：那份按整键「本机压过站点预设」合并，
 * 访客换一次线路就会把整个 `homepageMultiPingTaskIds` 钉死在本机，站长以后在设置页改线路再也
 * 传不到这台设备。这里只记逐节点、逐行的差异，站点设置照旧打底（见 `resolveNodePingLineTaskIds`）。
 */

const STORAGE_KEY = "cfsm-luminaplus:ping-line-overrides";

type Listener = () => void;
type OverridesByNode = Readonly<Record<string, PingLineOverrides>>;

const listeners = new Set<Listener>();
let cache: OverridesByNode | null = null;

const isKnownTaskId = (taskId: number) => CARRIER_TASK_BY_ID.has(taskId);

// uuid 来自存储内容，按普通对象的键直接读会撞上原型上的 `constructor` 之类。
function hasOwn(target: object, key: string) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function readStorage(): OverridesByNode {
  if (cache) return cache;
  const next: Record<string, PingLineOverrides> = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [uuid, value] of Object.entries(parsed)) {
        if (!uuid || uuid === "__proto__") continue;
        const overrides = normalizePingLineOverrides(value, isKnownTaskId);
        if (overrides !== EMPTY_PING_LINE_OVERRIDES) next[uuid] = overrides;
      }
    }
  } catch {
    // 存储不可用或内容损坏：当作谁都没换过，首页照常按站点设置画。
  }
  cache = next;
  return cache;
}

function sameOverrides(left: PingLineOverrides, right: PingLineOverrides) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

/** 这台节点换过的行；没换过返回共享的空表，可以直接当 useSyncExternalStore 的快照。 */
export function getPingLineOverrides(uuid: string): PingLineOverrides {
  const all = readStorage();
  return hasOwn(all, uuid) ? all[uuid]! : EMPTY_PING_LINE_OVERRIDES;
}

/** 整份替换这台节点的覆盖表；传空表 = 这台节点恢复站点设置。 */
export function setPingLineOverrides(uuid: string, overrides: PingLineOverrides): void {
  if (!uuid || uuid === "__proto__") return;
  const normalized = normalizePingLineOverrides(overrides, isKnownTaskId);
  if (sameOverrides(getPingLineOverrides(uuid), normalized)) return;
  // 只换这一台的条目，其余节点的对象引用不变 —— 它们的卡片不会因为别人换线路而重渲染。
  const next: Record<string, PingLineOverrides> = { ...readStorage() };
  if (normalized === EMPTY_PING_LINE_OVERRIDES) delete next[uuid];
  else next[uuid] = normalized;
  cache = next;
  try {
    if (Object.keys(next).length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    // 隐私模式/配额用尽时写不进去，本次会话内照样生效。
    console.warn("[LuminaPlus] 线路切换无法写入本地存储", error);
  }
  emit();
}

export function subscribePingLineOverrides(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  for (const listener of listeners) listener();
}

// 另一个标签页换了线路时同步过来。
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    cache = null;
    emit();
  });
}
