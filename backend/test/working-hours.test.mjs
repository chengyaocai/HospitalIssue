// v1.18.28: workingHoursBetween 单元测试 + computeDashboard 工时口径集成校验。
// 全部用本地时区固定时间构造（new Date(y, m, d, h, min)），不依赖当前时间，完全确定。
// 参考星期（2026-09/10）：9/28 周一、9/29 周二、10/2 周五、10/3 周六、10/4 周日、10/5 周一。
import assert from 'node:assert/strict';
import { workingHoursBetween, computeDashboard } from '../src/db/aggregate.js';

const at = (m, d, h, min = 0) => new Date(2026, m - 1, d, h, min, 0);
let passed = 0;
function ok(actual, expected, msg) {
  assert.ok(
    typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
    `${msg}: expected ${expected}, got ${actual}`
  );
  passed++;
}

// ---- 1. 同一工作时段内：周一 10:00→11:00 = 1h ----
ok(workingHoursBetween(at(9, 28, 10), at(9, 28, 11)), 1, '同段 1h');

// ---- 2. 跨午休：周一 10:00→14:00 = 10-12(2h) + 13-14(1h) = 3h ----
ok(workingHoursBetween(at(9, 28, 10), at(9, 28, 14)), 3, '跨午休 3h');

// ---- 3. 整个工作日：周一 08:00→17:00 = 4h + 4h = 8h ----
ok(workingHoursBetween(at(9, 28, 8), at(9, 28, 17)), 8, '整工作日 8h');

// ---- 4. 全夜：周一 17:30→周二 07:30 = 0（夜间不计） ----
ok(workingHoursBetween(at(9, 28, 17, 30), at(9, 29, 7, 30)), 0, '全夜 0');

// ---- 5. 跨周末：周五 16:00→下周一 09:30 = 周五16-17(1h) + 周六日(0) + 周一08:00-09:30(1.5h) = 2.5h ----
ok(workingHoursBetween(at(10, 2, 16), at(10, 5, 9, 30)), 2.5, '跨周末 2.5h');

// ---- 6. 纯周末：周六 10:00→周日 15:00 = 0 ----
ok(workingHoursBetween(at(10, 3, 10), at(10, 4, 15)), 0, '纯周末 0');

// ---- 7. 半开区间：周五 17:00 整（终点不计）→ 周一 08:00（终点不计）= 0 ----
ok(workingHoursBetween(at(10, 2, 17), at(10, 5, 8)), 0, '周五17:00整→周一08:00 = 0');

// ---- 8. end < start 与 end == start 均 0 ----
ok(workingHoursBetween(at(9, 28, 11), at(9, 28, 10)), 0, 'end<start = 0');
ok(workingHoursBetween(at(9, 28, 10), at(9, 28, 10)), 0, 'end==start = 0');

// ---- 9. 非法日期 = 0（Invalid Date / null / undefined） ----
ok(workingHoursBetween(new Date('not-a-date'), at(9, 28, 11)), 0, '非法 start = 0');
ok(workingHoursBetween(at(9, 28, 10), new Date('not-a-date')), 0, '非法 end = 0');
ok(workingHoursBetween(null, at(9, 28, 11)), 0, 'null start = 0');
ok(workingHoursBetween(at(9, 28, 10), undefined), 0, 'undefined end = 0');

// ---- 10. 边界含秒：周一 11:30→11:45 = 0.25h ----
ok(workingHoursBetween(at(9, 28, 11, 30), at(9, 28, 11, 45)), 0.25, '含秒 0.25h');

// ---- 11. 起点早于时段：周一 07:00→09:00 = 08:00-09:00 = 1h ----
ok(workingHoursBetween(at(9, 28, 7), at(9, 28, 9)), 1, '起点早于08:00 截到 1h');

// ---- 12. 终点恰为 12:00 整：周一 10:00→12:00 = 2h（上午段满额） ----
ok(workingHoursBetween(at(9, 28, 10), at(9, 28, 12)), 2, '终点12:00整 = 2h');

// ---- 13. computeDashboard 集成：8h 场景 + 0 场景 → avg = round1(8/2) = 4 ----
// 记录 A：周一 08:00→17:00 = 8h；记录 B：周六→周日 = 0h（仍计入 resolveN）
const dashRows = [
  { status: '已解决', created_at: at(9, 28, 8), resolved_at: at(9, 28, 17) },
  { status: '已解决', created_at: at(10, 3, 10), resolved_at: at(10, 4, 11) },
];
const dash = computeDashboard(dashRows, at(9, 28, 12));
assert.equal(dash.kpi.avgResolveHours, 4, 'computeDashboard: avgResolveHours=round1((8+0)/2)=4');
passed++;
assert.equal(dash.kpi.resolved, 2, 'computeDashboard: resolved=2');
passed++;

// ---- 14. 非法 resolved_at 的记录不计入平均值（与原逻辑一致：toDate 为 null 跳过） ----
const dashBad = computeDashboard(
  [...dashRows, { status: '已解决', created_at: at(9, 28, 8), resolved_at: 'garbage' }],
  at(9, 28, 12)
);
assert.equal(dashBad.kpi.avgResolveHours, 4, 'computeDashboard: 非法 resolved_at 不计入 avg');
passed++;

// ---- 15. 大跨度防御分支：>400 天不挂死，按工作日占比粗估（5/7 × 8/24） ----
// 500 天自然时长 = 12000h；粗估 = 12000 × 5/7 × 8/24 = 12000 × 5/21 ≈ 2857.142857h
const longStart = new Date(2026, 0, 1, 0, 0, 0);
const longEnd = new Date(2026, 0, 1 + 500, 0, 0, 0); // 500 天后
const longVal = workingHoursBetween(longStart, longEnd);
assert.ok(Number.isFinite(longVal) && longVal > 0, `防御分支: 返回正数(实际 ${longVal})`);
assert.ok(
  Math.abs(longVal - (12000 * 5 / 7 * 8 / 24)) < 1e-6,
  `防御分支: 粗估值 12000h×5/7×8/24 (实际 ${longVal})`
);
passed += 2;

console.log(`working-hours: ${passed} assertions passed`);
