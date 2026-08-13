export type HomepagePingTaskBindings = Record<string, string[]>;
export const HOMEPAGE_MULTI_PING_TASK_COUNT = 3;

/**
 * CF-Server-Monitor 的探测点是固定的四条线路（电信/联通/移动/BD），每台节点都具备，
 * 因此没有绑定关系的节点直接落到默认线路，而不是不显示延迟。
 */
export const DEFAULT_HOMEPAGE_PING_TASK_ID = 1;

/**
 * 三网模式的默认三条线路：电信 / 联通 / 移动（BD 不在其中）。
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
    if (normalized.length === HOMEPAGE_MULTI_PING_TASK_COUNT) break;
  }
  return normalized;
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
): Map<string, number[]> {
  const selectedTaskIds = normalizeHomepageMultiPingTaskIds(multiTaskIds);
  const selectedTaskIdsByClient = new Map<string, number[]>();

  if (selectedTaskIds.length === HOMEPAGE_MULTI_PING_TASK_COUNT) {
    for (const uuid of clientUuids) {
      if (uuid) selectedTaskIdsByClient.set(uuid, selectedTaskIds);
    }
    return selectedTaskIdsByClient;
  }

  const singleTaskByClient = invertHomepagePingTaskBindings(bindings);
  for (const uuid of clientUuids) {
    if (!uuid) continue;
    selectedTaskIdsByClient.set(uuid, [
      singleTaskByClient.get(uuid) ?? DEFAULT_HOMEPAGE_PING_TASK_ID,
    ]);
  }
  return selectedTaskIdsByClient;
}

export function resolveHomepagePingSelections(
  clientUuids: string[],
  bindings: HomepagePingTaskBindings,
  multiTaskIds: number[] = [],
) {
  const normalizedMultiTaskIds =
    normalizeHomepageMultiPingTaskIds(multiTaskIds);
  const useMultiPing =
    normalizedMultiTaskIds.length === HOMEPAGE_MULTI_PING_TASK_COUNT;
  const singleTaskIdsByClient = useMultiPing
    ? new Map<string, number[]>()
    : resolveHomepagePingTaskIdsByClient(clientUuids, bindings);
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
