// 值班表日期工具：统一按 UTC 解析/格式化「YYYY-MM-DD」，避免本地时区造成日期偏移。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 是否为真实存在的日历日期（拒绝 2024-02-30 之类的滚动日期）。
export function isDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// 日期加减 n 天，返回 YYYY-MM-DD。
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// b - a 的天数差（两个日期都必须是 YYYY-MM-DD）。
export function diffDays(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// 某日期所在周的周一（中国习惯周一起始）。
export function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const delta = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

// 今天的日期（本地时区），YYYY-MM-DD。
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
