// 排序支持（list / export 共用）。
// 说明：严重程度与状态按「业务语义」排序，而不是按中文字面顺序。
export const SORTABLE_KEYS = [
  'id', 'title', 'department', 'reporter', 'type',
  'severity', 'status', 'created_at', 'updated_at', 'resolved_at', 'audit_at',
];

const SEVERITY_RANK = { 低: 1, 中: 2, 高: 3, 紧急: 4 };
const STATUS_RANK = { 待处理: 1, 处理中: 2, 已解决: 3, 已关闭: 4 };

export const DEFAULT_SORT = { by: 'created_at', order: 'desc' };

// 归一化：非法字段回落到默认，非法方向回落到 desc
export function normalizeSort(sort, order) {
  const by = SORTABLE_KEYS.includes(sort) ? sort : DEFAULT_SORT.by;
  const dir = order === 'asc' ? 'asc' : order === 'desc' ? 'desc' : DEFAULT_SORT.order;
  return { by, dir };
}

function compare(a, b, by) {
  if (by === 'severity') return (SEVERITY_RANK[a.severity] || 9) - (SEVERITY_RANK[b.severity] || 9);
  if (by === 'status') return (STATUS_RANK[a.status] || 9) - (STATUS_RANK[b.status] || 9);
  if (by === 'id') return (Number(a.id) || 0) - (Number(b.id) || 0);
  return String(a[by] ?? '').localeCompare(String(b[by] ?? ''), 'zh');
}

export function sortRows(rows, sort, order) {
  const { by, dir } = normalizeSort(sort, order);
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const r = compare(a, b, by);
    if (r !== 0) return r * sign;
    // 同值时用 id 兜底（方向与主排序一致）：避免同毫秒创建时"最新在前"失效，同时保证分页稳定
    return ((Number(a.id) || 0) - (Number(b.id) || 0)) * sign;
  });
}
