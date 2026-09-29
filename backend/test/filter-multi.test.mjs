// v1.18.45 专项测试：问题登记筛选多选（status / type / department 逗号分隔多值）。
//
// 规则钉住：
//   1) 多值筛选：status=待处理,处理中 只返回这两种（dev + mssql 语 义由同一 API 契约保证，此处 dev 真起后端）；
//   2) 单值筛选完全向后兼容（status=已关闭 行为不变）；
//   3) 多值 + 其它条件组合（type 多值 / department 多值 / keyword）正常交集；
//   4) 非法/空段值被忽略（status=待处理,,xxx → 只按 待处理 过滤，不 500）；
//   5) 导出 describeConditions 多值展示为「、」连接（状态=待处理、处理中）；
//   6) 跨机构隔离不受多值影响（机构 2 的数据不出现）。
//
// 运行：cd backend && node test/filter-multi.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4220 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `fmulti-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `fmulti-uploads-${stamp}`);

// —— 种子：直接写 dev issues 数组（平铺 JSON），覆盖 3 状态 × 2 类型 × 2 科室 × 2 机构 ——
const now = new Date().toISOString();
const mk = (id, title, status, type, department, orgId = 1) => ({
  id, org_id: orgId, title,
  department, reporter: '张三', contact: '', type, severity: '中',
  status, description: `种子${id}`, handler: '', registrar: 'admin', softwareSystem: 'HIS',
  resolution: '', attachments: [], createdBy: 'admin',
  audit_status: '待审核', audit_reason: '', audit_by: '', audit_at: null,
  satisfaction: '', feedback: '', rated_at: null,
  created_at: now, updated_at: now, resolved_at: null, deleted_at: null,
});
const seed = [
  mk(1, '挂号卡顿', '待处理', '故障', '急诊科'),
  mk(2, '报告打印慢', '处理中', '需求', '急诊科'),
  mk(3, 'LIS接口异常', '已解决', '故障', '信息科'),
  mk(4, '体检科汇总', '已关闭', '需求', '信息科'),
  mk(5, '机构2的问题', '待处理', '故障', '急诊科', 2),
];
fs.writeFileSync(files.DEV_DB_PATH, JSON.stringify(seed, null, 2), 'utf8');

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'filter-multi-test-secret',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin123', ADMIN_NAME: 'SystemAdmin',
    UPLOADS_DIR: uploads,
    ...files,
  },
  stdio: 'ignore',
});

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return; } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务未就绪');
}
function cleanup() {
  try { server.kill(); } catch { /* ignore */ }
  for (const f of Object.values(files)) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { fs.rmSync(uploads, { recursive: true, force: true }); } catch { /* ignore */ }
}
const J = async (url, token, opts = {}) => {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON（CSV 等） */ }
  return { status: r.status, body, text: body === null ? await r.clone().text().catch(() => '') : null };
};
const login = async (username, password) => J(`${BASE}/api/auth/login`, null, {
  method: 'POST', body: JSON.stringify({ username, password }),
});
const titles = (rows) => (rows || []).map((r) => r.title).sort();

async function main() {
  await waitReady();
  const admin = await login('admin', 'admin123');
  assert(admin.status === 200, `登录成功（HTTP ${admin.status}）`);
  const tk = admin.body.token;

  // ===== 1. 基线：无筛选返回本机构 4 条（机构 2 的不出现）=====
  const all = await J(`${BASE}/api/problems`, tk);
  assert(all.body.rows && all.body.rows.length === 4, `无筛选返回 4 条（机构隔离，实测 ${(all.body.rows || []).length}）`);

  // ===== 2. 状态多值 =====
  const two = await J(`${BASE}/api/problems?status=${encodeURIComponent('待处理,处理中')}`, tk);
  assert(JSON.stringify(titles(two.body.rows)) === JSON.stringify(['报告打印慢', '挂号卡顿']),
    `状态多值=待处理,处理中 → 恰 2 条（实测 ${JSON.stringify(titles(two.body.rows))}）`);

  // ===== 3. 单值向后兼容 =====
  const one = await J(`${BASE}/api/problems?status=${encodeURIComponent('已关闭')}`, tk);
  assert(JSON.stringify(titles(one.body.rows)) === JSON.stringify(['体检科汇总']),
    `单值 status=已关闭 向后兼容（实测 ${JSON.stringify(titles(one.body.rows))}）`);

  // ===== 4. 类型多值 + 科室多值交集 =====
  const mix = await J(`${BASE}/api/problems?type=${encodeURIComponent('故障,需求')}&department=${encodeURIComponent('信息科,急诊科')}&status=${encodeURIComponent('已解决,已关闭')}`, tk);
  assert(JSON.stringify(titles(mix.body.rows)) === JSON.stringify(['LIS接口异常', '体检科汇总']),
    `类型+科室+状态三组多值交集 → 恰 2 条（实测 ${JSON.stringify(titles(mix.body.rows))}）`);

  // ===== 5. 脏值防御：空段丢弃、未知值参与但不 500 =====
  const dirty = await J(`${BASE}/api/problems?status=${encodeURIComponent('待处理,,不存在的状态')}`, tk);
  assert(dirty.status === 200 && JSON.stringify(titles(dirty.body.rows)) === JSON.stringify(['挂号卡顿']),
    `脏值（空段+未知值）不 500 且按有效值过滤（实测 ${JSON.stringify(titles(dirty.body.rows))}）`);
  const empty = await J(`${BASE}/api/problems?status=${encodeURIComponent(',,,')}`, tk);
  assert(empty.status === 200 && (empty.body.rows || []).length === 4,
    `全空段=不过滤（返回 4 条，实测 ${(empty.body.rows || []).length}）`);

  // ===== 6. 多值 + keyword 组合 =====
  const kw = await J(`${BASE}/api/problems?status=${encodeURIComponent('待处理,处理中')}&keyword=${encodeURIComponent('挂号')}`, tk);
  assert(JSON.stringify(titles(kw.body.rows)) === JSON.stringify(['挂号卡顿']),
    `多值+关键字交集（实测 ${JSON.stringify(titles(kw.body.rows))}）`);

  // ===== 7. 导出：多值筛选生效且说明文案为「、」连接 =====
  const exp = await fetch(`${BASE}/api/problems/export?format=csv&status=${encodeURIComponent('待处理,处理中')}`, { headers: { Authorization: `Bearer ${tk}` } });
  const csv = await exp.text();
  assert(exp.status === 200 && csv.includes('挂号卡顿') && csv.includes('报告打印慢') && !csv.includes('体检科汇总'),
    `导出按多值筛选（CSV 含 2 条、不含已关闭）`);
  assert(csv.includes('待处理、处理中'), `导出说明多值用「、」连接（CSV 含『状态=待处理、处理中』）`);
}

try {
  await main();
} finally {
  cleanup();
}
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
