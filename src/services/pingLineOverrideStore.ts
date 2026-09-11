import { CARRIER_TASK_BY_ID } from "@/services/cfsm/mappers";
import {
  EMPTY_PING_LINE_OVERRIDES,
  EMPTY_PING_LINE_OVERRIDES_BY_NODE,
  nodePingLineOverrides,
  normalizePingLineOverrides,
  normalizePingLineOverridesByNode,
  type PingLineOverrides,
  type PingLineOverridesByNode,
} from "@/utils/pingLineOverrides";

/**
 * 在首页卡片上点线路名换过的线路（多线路模式），按节点 uuid 分开存在本机。
 *
 * 故意不进主题设置那份 localStorage（`themeSettingsStore`）：那份按整键「本机压过站点预设」合并，
 * 换一次线路就会把整个 `homepageMultiPingTaskIds` 钉死在本机，站长以后在设置页改线路再也
 * 传不到这台设备。这里只记逐节点、逐行的差异，站点那份照旧打底。
 *
 * 访客换的只留在本机；登录站长在设置页点「保存到后端」时，这份会并进主题配置的
 * `homepagePingLineOverrides`（见 `mergePingLineOverridesByNode`），保存成功后清掉。
 */

const STORAGE_KEY = "cfsm-luminaplus:ping-line-overrides";

type Listener = () => void;

const listeners = new Set<Listener>();
let cache: PingLineOverridesByNode | null = null;

const isKnownTaskId = (taskId: number) => CARRIER_TASK_BY_ID.has(taskId);

function readStorage(): PingLineOverridesByNode {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // 存储不可用或内容损坏：当作谁都没换过，首页照常按站点设置画。
  }
  cache = normalizePingLineOverridesByNode(parsed, isKnownTaskId);
  return cache;
}

function persist(next: PingLineOverridesByNode) {
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

function sameOverrides(left: PingLineOverrides, right: PingLineOverrides) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

/** 这台节点换过的行；没换过返回共享的空表，可以直接当 useSyncExternalStore 的快照。 */
export function getPingLineOverrides(uuid: string): PingLineOverrides {
  return nodePingLineOverrides(readStorage(), uuid);
}

/** 所有节点换过的行（设置页拼「保存到后端」快照用）；没有变化时引用不变。 */
export function getAllPingLineOverrides(): PingLineOverridesByNode {
  return readStorage();
}

/** 整份替换这台节点的覆盖表；传空表 = 这台节点恢复默认。 */
export function setPingLineOverrides(uuid: string, overrides: PingLineOverrides): void {
  if (!uuid || uuid === "__proto__") return;
  const normalized = normalizePingLineOverrides(overrides, isKnownTaskId);
  if (sameOverrides(getPingLineOverrides(uuid), normalized)) return;
  // 只换这一台的条目，其余节点的对象引用不变 —— 它们的卡片不会因为别人换线路而重渲染。
  const next: Record<string, PingLineOverrides> = { ...readStorage() };
  if (normalized === EMPTY_PING_LINE_OVERRIDES) delete next[uuid];
  else next[uuid] = normalized;
  persist(Object.keys(next).length > 0 ? next : EMPTY_PING_LINE_OVERRIDES_BY_NODE);
}

/** 清掉所有节点换过的线路：「保存到后端」成功（已并进站点配置）或「改用后端配置」时调用。 */
export function clearPingLineOverrides(): void {
  if (Object.keys(readStorage()).length === 0) return;
  persist(EMPTY_PING_LINE_OVERRIDES_BY_NODE);
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
