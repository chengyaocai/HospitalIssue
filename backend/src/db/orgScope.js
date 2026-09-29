// 多机构（v1.18）行级隔离 —— dev 驱动的公共工具。
//
// 约定：
// - 存量数据（升级前写入）没有 org_id 字段，一律视为归属「默认机构」；
// - 默认机构由启动时 orgs/ensureOrgs 创建，是 app_org 的第一条记录，id 恒为 1
//   （与 mssql 侧 org_id BIGINT NOT NULL DEFAULT 1 的语义完全一致）；
// - orgId 为 null/undefined 时不施加机构过滤（保留单机构/未传机构的旧行为）。
export const DEFAULT_ORG_ID = 1;

// 行归属的机构 id（无 org_id 的存量数据视为默认机构）。
export function orgOf(row) {
  const v = row && row.org_id;
  return v == null ? DEFAULT_ORG_ID : Number(v);
}

// 按机构过滤行集合。
export function filterByOrg(rows, orgId) {
  if (orgId == null) return rows;
  const target = Number(orgId);
  return rows.filter((r) => orgOf(r) === target);
}

// 单行是否归属指定机构。
export function inOrg(row, orgId) {
  if (orgId == null) return true;
  return orgOf(row) === Number(orgId);
}
