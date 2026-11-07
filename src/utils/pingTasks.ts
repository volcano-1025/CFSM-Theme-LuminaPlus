export type HomepagePingTaskBindings = Record<string, string[]>;

/**
 * 多线路模式最多同时显示几条线路。后端 2.8.5 Beta4 起是八条探测线路（`CARRIER_TASKS`），这个数跟着它走
 * —— 以后后端加线路，`pingTasks.test.ts` 里那条「和 CARRIER_TASKS 对齐」的断言会先失败，
 * 提醒把这里一起抬上去（util 层不直接 import services，免得把适配层拖进纯函数的依赖里）。
 */
export const HOMEPAGE_MULTI_PING_MAX_COUNT = 8;

/**
 * 至少选几条才算配置好。**1 条也是合法配置**（v1.2.14 之前写死必须三条）：站长可能只关心
 * 一条线路，但仍想要多线路模式那套「每条线各一行延迟 + 丢包」的排版。选 0 条才回退到
 * 单线路模式（按节点各自的绑定显示一条）。
 */
export const HOMEPAGE_MULTI_PING_MIN_COUNT = 1;

/** 多线路模式的任务选够了没有。首页消费方与设置页的校验共用这一条口径。 */
export function isHomepageMultiPingConfigured(taskIds: readonly number[]): boolean {
  return taskIds.length >= HOMEPAGE_MULTI_PING_MIN_COUNT;
}

/**
 * 兜底的默认线路：电信。CF-Server-Monitor 的探测线路由后端固定（八条），没有绑定关系的节点
 * 直接落到默认线路，而不是不显示延迟。
 */
export const DEFAULT_HOMEPAGE_PING_TASK_ID = 1;

/** 站长选的「默认线路」有效才用它，否则退回 {@link DEFAULT_HOMEPAGE_PING_TASK_ID}。 */
export function resolveDefaultHomepagePingTaskId(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_HOMEPAGE_PING_TASK_ID;
}

/**
 * 多线路模式没配过时的默认：三条线路（电信 / 联通 / 移动，BD 不在其中）—— 沿用「三网」时代的
 * 口径，存量站点升级后看到的东西不变。条数本身可由站长在设置页改成 1~{@link HOMEPAGE_MULTI_PING_MAX_COUNT} 条。
 * 线路 id 由 CARRIER_TASKS 固定，不会因站点而异，所以可以硬编码成默认值。
 */
export const DEFAULT_HOMEPAGE_MULTI_PING_TASK_IDS: readonly number[] = [1, 2, 3];

const invertedBindingsCache = new WeakMap<HomepagePingTaskBindings, Map<string, number>>();

function parseTaskId(taskId: string) {
  if (!/^\d+$/.test(taskId)) return null;
  const parsed = Number(taskId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeHomepageMultiPingTaskIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];

  const normalized: number[] = [];
  for (const raw of value) {
    const taskId =
      typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
        ? raw
        : typeof raw === "string"
          ? parseTaskId(raw)
          : null;
    if (taskId == null || normalized.includes(taskId)) continue;
    normalized.push(taskId);
    if (normalized.length === HOMEPAGE_MULTI_PING_MAX_COUNT) break;
  }
  return normalized;
}

/**
 * 把多线路的第 `slot` 条换成 `taskId`。选的线路已经在别的槽位时**两条互换**，不会选出两条一样的线路
 * —— 和首页卡片上点线路名换线路同一个口径（见 pingLineOverrides 的 `switchPingLine`）。
 * 槽位越界时原样返回（拷贝）。
 */
export function assignHomepageMultiPingTask(
  taskIds: readonly number[],
  slot: number,
  taskId: number,
): number[] {
  const next = [...taskIds];
  if (!Number.isInteger(slot) || slot < 0 || slot >= next.length) return next;
  const shownAt = next.indexOf(taskId);
  if (shownAt >= 0 && shownAt !== slot) next[shownAt] = next[slot]!;
  next[slot] = taskId;
  return next;
}

export function normalizeHomepagePingTaskBindings(
  value: unknown,
): HomepagePingTaskBindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized: HomepagePingTaskBindings = {};
  for (const [taskId, clients] of Object.entries(value)) {
    const numericTaskId = parseTaskId(taskId);
    if (numericTaskId == null || !Array.isArray(clients)) continue;

    const uniqueClients = Array.from(
      new Set(
        clients
          .map((client) => (typeof client === "string" ? client.trim() : ""))
          .filter(Boolean),
      ),
    );
    if (uniqueClients.length === 0) {
      continue;
    }

    const normalizedTaskId = String(numericTaskId);
    normalized[normalizedTaskId] = Array.from(
      new Set([...(normalized[normalizedTaskId] ?? []), ...uniqueClients]),
    );
  }

  return normalized;
}

export function invertHomepagePingTaskBindings(
  bindings: HomepagePingTaskBindings,
): Map<string, number> {
  const cached = invertedBindingsCache.get(bindings);
  if (cached) return cached;

  const selectedTaskByClient = new Map<string, number>();
  const entries = Object.entries(normalizeHomepagePingTaskBindings(bindings)).sort(
    ([left], [right]) => Number(left) - Number(right),
  );

  for (const [taskId, clients] of entries) {
    const numericTaskId = parseTaskId(taskId);
    if (numericTaskId == null) continue;
    for (const client of clients) {
      if (!selectedTaskByClient.has(client)) {
        selectedTaskByClient.set(client, numericTaskId);
      }
    }
  }

  invertedBindingsCache.set(bindings, selectedTaskByClient);
  return selectedTaskByClient;
}

export function hasHomepagePingTaskBinding(
  clientUuid: string,
  bindings: HomepagePingTaskBindings,
): boolean {
  return Boolean(clientUuid) && invertHomepagePingTaskBindings(bindings).has(clientUuid);
}

export function resolveHomepagePingTaskIdsByClient(
  clientUuids: string[],
  bindings: HomepagePingTaskBindings,
  multiTaskIds: number[] = [],
  defaultTaskId: number = DEFAULT_HOMEPAGE_PING_TASK_ID,
): Map<string, number[]> {
  const selectedTaskIds = normalizeHomepageMultiPingTaskIds(multiTaskIds);
  const selectedTaskIdsByClient = new Map<string, number[]>();

  if (isHomepageMultiPingConfigured(selectedTaskIds)) {
    for (const uuid of clientUuids) {
      if (uuid) selectedTaskIdsByClient.set(uuid, selectedTaskIds);
    }
    return selectedTaskIdsByClient;
  }

  const singleTaskByClient = invertHomepagePingTaskBindings(bindings);
  for (const uuid of clientUuids) {
    if (!uuid) continue;
    selectedTaskIdsByClient.set(uuid, [
      // 没单独绑过的节点走站点的「默认线路」—— 写死电信会让「全站都绑联通」的站点
      // 每加一台新节点就冒出一条电信（站长得记得回来手动绑，v1.2.14 之前就是这样）。
      singleTaskByClient.get(uuid) ?? resolveDefaultHomepagePingTaskId(defaultTaskId),
    ]);
  }
  return selectedTaskIdsByClient;
}

export function resolveHomepagePingSelections(
  clientUuids: string[],
  bindings: HomepagePingTaskBindings,
  multiTaskIds: number[] = [],
  defaultTaskId: number = DEFAULT_HOMEPAGE_PING_TASK_ID,
) {
  const normalizedMultiTaskIds =
    normalizeHomepageMultiPingTaskIds(multiTaskIds);
  const useMultiPing = isHomepageMultiPingConfigured(normalizedMultiTaskIds);
  const singleTaskIdsByClient = useMultiPing
    ? new Map<string, number[]>()
    : resolveHomepagePingTaskIdsByClient(clientUuids, bindings, [], defaultTaskId);
  const multiTaskIdsByClient = useMultiPing
    ? resolveHomepagePingTaskIdsByClient(
        clientUuids,
        {},
        normalizedMultiTaskIds,
      )
    : new Map<string, number[]>();

  return {
    singleTaskIdsByClient,
    multiTaskIdsByClient,
    requestedTaskIdsByClient: useMultiPing
      ? multiTaskIdsByClient
      : singleTaskIdsByClient,
  };
}

/**
 * 详情页 Ping 图的线路顺序跟卡片走（issue #13）：卡片上显示的线路按卡片顺序排在前，其余照原顺序排在后。
 * `cardOrder` 为空（单线路模式）时原样返回。
 */
export function orderTasksByCardLines<T extends { id: number }>(
  tasks: readonly T[],
  cardOrder: readonly number[],
): T[] {
  if (cardOrder.length === 0) return [...tasks];
  const rank = new Map(cardOrder.map((taskId, index) => [taskId, index] as const));
  return tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (left, right) =>
        (rank.get(left.task.id) ?? cardOrder.length + left.index) -
        (rank.get(right.task.id) ?? cardOrder.length + right.index),
    )
    .map(({ task }) => task);
}
