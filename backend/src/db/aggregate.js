// 数据驾驶舱聚合：dev（内存行）/ mssql（查出的行）两驱动共用同一套计算，
// 保证两侧数字口径完全一致。所有补零/排序逻辑都集中在此。
import { TYPES, SEVERITIES, STATUSES, SATISFACTIONS } from '../validators.js';

export const DASH_STATUSES = [...STATUSES];            // 待处理/处理中/已解决/已关闭
export const DASH_TYPES = [...TYPES];                  // 故障/需求/咨询/其他
export const DASH_SEVERITIES = [...SEVERITIES];        // 低/中/高/紧急
export const DASH_SATISFACTIONS = [...SATISFACTIONS];  // 满意/一般/不满意

function round1(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

function pct(part, whole) {
  return whole > 0 ? round1((part / whole) * 100) : 0;
}

// 本地时区日期键 YYYY-MM-DD（与业务展示一致，避免 UTC 跨天误差）
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 本地时区月份键 YYYY-MM
function ym(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 按取值归一（空值归入 fallback），返回 { label: count }
function tally(rows, pick) {
  const m = {};
  for (const r of rows) {
    const k = pick(r);
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

// 固定顺序补零
function fixedOrder(map, order, keyName) {
  return order.map((k) => ({ [keyName]: k, count: map[k] || 0 }));
}

// 计数对象转「按数量降序」列表（同值按名称稳定排序）
function sortedEntries(map, keyName, limit) {
  const arr = Object.entries(map).map(([k, count]) => ({ [keyName]: k, count }));
  arr.sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName]), 'zh'));
  return limit ? arr.slice(0, limit) : arr;
}

// 近 n 个月（含本月）的月份键，升序
function monthsBack(n, now) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(ym(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  return out;
}

// 近 n 天（含今天）的日期键，升序
function daysBack(n, now) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return out;
}

// 工作时段定义（v1.18.28）：周一~周五 08:00–12:00 + 13:00–17:00，每天 8 小时。
// 法定节假日暂不排除（无节假日数据源）——已知口径，部署说明同步标注。
// 半开区间：起点计入、终点不计（如 17:00:00 整不算工时）。
// 返回区间与工作时段交集的时长（小时，未取整）。
export function workingHoursBetween(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date)) return 0;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 0;
  if (end.getTime() <= start.getTime()) return 0;

  const MS_H = 3600000;
  const segs = [[8, 12], [13, 17]]; // 每天两个工作时段（本地时区）
  let sum = 0;
  // 防御分支：循环上限 400 天。正常数据不会出现这种跨度；超出则改用粗估
  // （工作日占比 5/7 × 每天 8h ÷ 24h），避免逐日循环在异常数据上挂死。
  const MAX_DAYS = 400;
  if ((end - start) / 86400000 > MAX_DAYS) {
    return ((end - start) / MS_H) * (5 / 7) * (8 / 24);
  }
  // 从 start 当天 00:00 起逐日推进（本地时区），累加每天两个时段的交集毫秒数
  for (let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
       day < end;
       day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const dow = day.getDay(); // 0=周日 6=周六
    if (dow < 1 || dow > 5) continue; // 仅周一~周五
    for (const [h0, h1] of segs) {
      const segStart = day.getTime() + h0 * MS_H;
      const segEnd = day.getTime() + h1 * MS_H;
      const from = Math.max(segStart, start.getTime());
      const to = Math.min(segEnd, end.getTime());
      if (to > from) sum += to - from;
    }
  }
  return sum / MS_H;
}

// 由「问题记录数组」计算完整驾驶舱数据。now 便于测试注入固定时间。
export function computeDashboard(rows, now = new Date()) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;

  const statusMap = tally(list, (r) => r.status || '');
  const typeMap = tally(list, (r) => r.type || '');
  const sevMap = tally(list, (r) => r.severity || '');
  const satMap = tally(list, (r) => r.satisfaction || '');

  const pending = (statusMap['待处理'] || 0) + (statusMap['处理中'] || 0);
  const resolved = statusMap['已解决'] || 0;
  const closed = statusMap['已关闭'] || 0;

  const todayKey = ymd(now);
  const curMonth = ym(now);
  const weekStartKey = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const prevMonth = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));

  let todayCount = 0;
  let weekCount = 0;
  let monthCount = 0;
  let lastMonthCount = 0;
  let resolveSum = 0;
  let resolveN = 0;
  let satisfied = 0;
  let neutral = 0;
  let dissatisfied = 0;
  let ratedCount = 0;
  const deptSet = new Set();
  const handlerSet = new Set();
  const sysSet = new Set();
  const monthMap = {};
  const dayMap = {};

  for (const r of list) {
    const created = toDate(r.created_at);
    if (created) {
      const dk = ymd(created);
      const mk = ym(created);
      if (dk === todayKey) todayCount++;
      if (dk >= weekStartKey) weekCount++;
      if (mk === curMonth) monthCount++;
      if (mk === prevMonth) lastMonthCount++;
      monthMap[mk] = (monthMap[mk] || 0) + 1;
      dayMap[dk] = (dayMap[dk] || 0) + 1;
    }
    const resAt = toDate(r.resolved_at);
    if (resAt && created) {
      // v1.18.28: 平均处理时长改按工作日 8 小时折算（周一~周五 08:00–12:00、13:00–17:00），
      // 夜间/周末不计；法定节假日暂不排除。与 frontend KPI 卡「按工作日折算」提示一致。
      resolveSum += workingHoursBetween(created, resAt);
      resolveN++;
    }

    const sat = r.satisfaction || '';
    if (sat) {
      ratedCount++;
      if (sat === '满意') satisfied++;
      else if (sat === '一般') neutral++;
      else if (sat === '不满意') dissatisfied++;
    }

    const dept = String(r.department || '').trim();
    if (dept) deptSet.add(dept);
    const handler = String(r.handler || '').trim();
    if (handler) handlerSet.add(handler);
    const sys = String(r.softwareSystem || '').trim();
    if (sys) sysSet.add(sys);
  }

  return {
    kpi: {
      total,
      pending,
      resolved,
      closed,
      resolvedRate: pct(resolved + closed, total),
      todayCount,
      weekCount,
      monthCount,
      lastMonthCount,
      monthDelta: monthCount - lastMonthCount,
      avgResolveHours: resolveN ? round1(resolveSum / resolveN) : 0,
      ratedCount,
      satisfactionRate: pct(satisfied, satisfied + neutral + dissatisfied),
      departmentCount: deptSet.size,
      handlerCount: handlerSet.size,
      softwareSystemCount: sysSet.size,
    },
    byStatus: fixedOrder(statusMap, DASH_STATUSES, 'status'),
    byType: fixedOrder(typeMap, DASH_TYPES, 'type'),
    bySeverity: fixedOrder(sevMap, DASH_SEVERITIES, 'severity'),
    byDepartment: sortedEntries(tally(list, (r) => String(r.department || '').trim() || '未指定'), 'department'),
    byMonth: monthsBack(12, now).map((month) => ({ month, count: monthMap[month] || 0 })),
    bySatisfaction: fixedOrder(satMap, DASH_SATISFACTIONS, 'name'),
    bySoftwareSystem: sortedEntries(tally(list, (r) => String(r.softwareSystem || '').trim() || '未指定'), 'softwareSystem'),
    byHandler: sortedEntries(tally(list, (r) => String(r.handler || '').trim() || '未指派'), 'handler', 10),
    byCreator: sortedEntries(tally(list, (r) => String(r.createdBy || '').trim() || '（历史数据）'), 'username', 10),
    byRecentDays: daysBack(14, now).map((date) => ({ date, count: dayMap[date] || 0 })),
  };
}
