import type { NodeInfo } from "@/types/cfsm";

// 隐藏与计费忽略共用大小写无关的节点身份匹配。

function normalizeNodeIdentityValue(value: unknown): string {
  return String(value == null ? "" : value).trim().toLowerCase();
}

// 把用户输入(字符串按换行/逗号/分号分隔,或已是数组)归一化成去重、去空的列表。
export function normalizeNodeIdentityList(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,，;；]+/)
      : [];

  return Array.from(
    new Set(
      rawValues
        .map((item) =>
          typeof item === "string" || typeof item === "number" ? String(item).trim() : "",
        )
        .filter(Boolean),
    ),
  );
}

export function buildNodeIdentitySet(values: string[]): Set<string> {
  return new Set(values.map(normalizeNodeIdentityValue).filter(Boolean));
}

const IDENTITY_FIELDS = [
  "id",
  "uuid",
  "name",
  "display_name",
  "remark",
  "alias",
  "public_remark",
] as const;

// 节点的任一身份字段命中集合即视为匹配。
export function nodeMatchesIdentitySet(node: NodeInfo, identitySet: Set<string>): boolean {
  if (identitySet.size === 0) return false;
  const record = node as unknown as Record<string, unknown>;
  for (const field of IDENTITY_FIELDS) {
    const normalized = normalizeNodeIdentityValue(record[field]);
    if (normalized && identitySet.has(normalized)) return true;
  }
  return false;
}

// 摘要不含名称，因此从完整 meta 收集匹配的 UUID。
export function collectMatchingNodeUuids(nodes: NodeInfo[], identityList: string[]): Set<string> {
  const identitySet = buildNodeIdentitySet(identityList);
  const uuids = new Set<string>();
  if (identitySet.size === 0) return uuids;
  for (const node of nodes) {
    if (nodeMatchesIdentitySet(node, identitySet)) uuids.add(node.uuid);
  }
  return uuids;
}
