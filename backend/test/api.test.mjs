// 端到端测试：dev 模式启动后端，验证 鉴权 / 角色权限 / 附件 / 审计 / 业务 CRUD / 导出。
// 运行：node test/api.test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import ExcelJS from 'exceljs';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'node:url';
import { computeDashboard } from '../src/db/aggregate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3310;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmpDb = path.join(os.tmpdir(), `issues-test-${stamp}.json`);
const tmpUsers = path.join(os.tmpdir(), `users-test-${stamp}.json`);
const tmpAudit = path.join(os.tmpdir(), `audit-test-${stamp}.json`);
const tmpUploads = path.join(os.tmpdir(), `uploads-test-${stamp}`);
const tmpSettings = path.join(os.tmpdir(), `settings-test-${stamp}.json`);
const tmpNotifications = path.join(os.tmpdir(), `notifications-test-${stamp}.json`);
const tmpChat = path.join(os.tmpdir(), `chat-test-${stamp}.json`);
const tmpOrgs = path.join(os.tmpdir(), `orgs-test-${stamp}.json`);
const tmpSchedules = path.join(os.tmpdir(), `schedules-test-${stamp}.json`);

// 固定 JWT 密钥：测试里需要自签「升级前的旧 token」「自称平台管理员的伪造 token」来验证守卫以库为准。
const LEGACY_SECRET = 'test-secret-legacy-platform';
const jwtSign = (payload, secret) => jwt.sign(payload, secret, { expiresIn: '12h' });

const env = {
  ...process.env,
  DB_DRIVER: 'dev',
  JWT_SECRET: LEGACY_SECRET,
  DEV_DB_PATH: tmpDb,
  DEV_USERS_PATH: tmpUsers,
  AUDIT_DEV_PATH: tmpAudit,
  UPLOADS_DIR: tmpUploads,
  SETTINGS_DEV_PATH: tmpSettings,
  NOTIFICATIONS_DEV_PATH: tmpNotifications,
  CHAT_DEV_PATH: tmpChat,
  ORGS_DEV_PATH: tmpOrgs,
  SCHEDULE_DEV_PATH: tmpSchedules,
  PORT: String(PORT),
};
const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env, stdio: 'inherit' });

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

async function waitReady() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready');
}

let TOKEN = '';
async function authFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}), Authorization: 'Bearer ' + TOKEN };
  return fetch(BASE + url, { ...opts, headers });
}
function tokenFetch(token, url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}), Authorization: 'Bearer ' + token };
  return fetch(BASE + url, { ...opts, headers });
}

function cleanup() {
  server.kill();
  for (const f of [tmpDb, tmpUsers, tmpAudit, tmpSettings, tmpNotifications, tmpChat, tmpOrgs, tmpSchedules]) { try { fs.unlinkSync(f); } catch {} }
  try { fs.rmSync(tmpUploads, { recursive: true, force: true }); } catch {}
}

// ---- computeDashboard 纯函数单元校验（注入固定 now，完全确定性，不依赖外部状态）----
function runUnitDashboardChecks() {
  const now = new Date(2026, 5, 15, 10, 0, 0);            // 2026-06-15（本地时区）
  const at = (m, d, h = 9) => new Date(2026, m - 1, d, h, 0, 0).toISOString();
  const rows = [
    { status: '待处理', type: '故障', severity: '高', department: '内科', handler: '', softwareSystem: 'HIS', createdBy: 'admin', satisfaction: '', created_at: at(6, 15), resolved_at: null },
    { status: '处理中', type: '需求', severity: '中', department: '财务科', handler: '王五', softwareSystem: 'PACS', createdBy: '', satisfaction: '', created_at: at(6, 14), resolved_at: null },
    { status: '已解决', type: '咨询', severity: '低', department: '影像科', handler: '王五', softwareSystem: 'HIS', createdBy: 'admin', satisfaction: '满意', created_at: at(6, 10), resolved_at: at(6, 10, 12) },
    { status: '已关闭', type: '其他', severity: '紧急', department: '内科', handler: '', softwareSystem: '', createdBy: 'admin', satisfaction: '一般', created_at: at(5, 1), resolved_at: at(5, 1, 14) },
    { status: '已解决', type: '故障', severity: '中', department: '财务科', handler: '李四', softwareSystem: 'PACS', createdBy: 'admin', satisfaction: '不满意', created_at: at(6, 15), resolved_at: at(6, 15, 10) },
  ];
  const d = computeDashboard(rows, now);
  assert(d.kpi.total === 5, 'unit dashboard: total=5');
  assert(d.kpi.pending === 2, 'unit dashboard: pending=2 (待处理+处理中)');
  assert(d.kpi.resolved === 2, 'unit dashboard: resolved=2');
  assert(d.kpi.closed === 1, 'unit dashboard: closed=1');
  assert(d.kpi.resolvedRate === 60, 'unit dashboard: resolvedRate=60 (=(2+1)/5)');
  assert(d.kpi.satisfactionRate === 33.3, 'unit dashboard: satisfactionRate=33.3 (=1/3 四舍五入 1 位)');
  // v1.18.28: 工作日 8h 口径 —— 三条记录工时分别为 周三 9→12=3h / 周五 9→14=3h+13-14=1h 共 4h / 周一 9→10=1h，(3+4+1)/3=2.666…→2.7
  assert(d.kpi.avgResolveHours === 2.7, 'unit dashboard: avgResolveHours=2.7 (工作日8h口径: (3+4+1)/3)');
  assert(d.kpi.ratedCount === 3, 'unit dashboard: ratedCount=3');
  assert(d.kpi.departmentCount === 3, 'unit dashboard: departmentCount=3 (空值不计)');
  assert(d.kpi.handlerCount === 2, 'unit dashboard: handlerCount=2 (空处理人不计)');
  assert(d.kpi.softwareSystemCount === 2, 'unit dashboard: softwareSystemCount=2 (空系统不计)');
  assert(d.kpi.todayCount === 2, 'unit dashboard: todayCount=2');
  assert(d.kpi.monthCount === 4 && d.kpi.lastMonthCount === 1 && d.kpi.monthDelta === 3, 'unit dashboard: monthCount=4(6/14,6/15×2,6/10)/lastMonth=1/delta=3');
  assert(JSON.stringify(d.byStatus) === JSON.stringify([{ status: '待处理', count: 1 }, { status: '处理中', count: 1 }, { status: '已解决', count: 2 }, { status: '已关闭', count: 1 }]), 'unit dashboard: byStatus 固定顺序+补零');
  assert(JSON.stringify(d.bySeverity) === JSON.stringify([{ severity: '低', count: 1 }, { severity: '中', count: 2 }, { severity: '高', count: 1 }, { severity: '紧急', count: 1 }]), 'unit dashboard: bySeverity 固定顺序');
  assert(d.byMonth.length === 12 && d.byMonth.every((m, i, a) => i === 0 || a[i - 1].month < m.month) && d.byMonth[11].month === '2026-06' && d.byMonth[11].count === 4, 'unit dashboard: byMonth 12 项升序且末月=本月=4');
  assert(d.byRecentDays.length === 14 && d.byRecentDays.every((x, i, a) => i === 0 || a[i - 1].date < x.date) && d.byRecentDays[13].count === 2, 'unit dashboard: byRecentDays 14 项升序且今日=2');
  assert(d.byHandler.some((x) => x.handler === '未指派' && x.count === 2), 'unit dashboard: byHandler「未指派」归并=2');
  assert(d.byCreator.some((x) => x.username === '（历史数据）' && x.count === 1), 'unit dashboard: byCreator「（历史数据）」归并=1');
  // 空库 / 未回访边界：必须是数字 0，不是 NaN/null
  const e = computeDashboard([], now);
  assert(e.kpi.resolvedRate === 0 && e.kpi.satisfactionRate === 0 && e.kpi.avgResolveHours === 0, 'unit dashboard: 空库三类比值均 === 0');
  assert(Number.isFinite(e.kpi.resolvedRate) && Number.isFinite(e.kpi.satisfactionRate) && e.kpi.resolvedRate !== null, 'unit dashboard: 空库比值是数字(非 NaN/null)');
  const un = computeDashboard([{ status: '待处理', created_at: at(6, 15), satisfaction: '' }], now);
  assert(un.kpi.satisfactionRate === 0 && un.kpi.resolvedRate === 0, 'unit dashboard: 未回访/未解决 → 比值 0');
}

async function main() {
  runUnitDashboardChecks();
  await waitReady();

  const h = await (await fetch(BASE + '/api/health')).json();
  assert(h.ok === true, 'health ok');

  // ---- 鉴权 ----
  const badLogin = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });
  assert(badLogin.status === 401, 'login wrong password -> 401');
  assert((await fetch(BASE + '/api/problems')).status === 401, 'problems without token -> 401');

  const loginRes = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const loginData = await loginRes.json();
  assert(loginRes.status === 200 && loginData.token && loginData.user.role === 'admin', 'admin login returns token');
  TOKEN = loginData.token;
  const me = await (await authFetch('/api/auth/me')).json();
  assert(me.user && me.user.username === 'admin', 'GET /api/auth/me with token');

  // ---- 登录防爆破（v1.6）：连续 5 次失败锁定 10 分钟（进程内存级）----
  const loginAs = (u, p) => fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  // 1) 不存在的用户名同样计数（防枚举爆破）
  for (let i = 0; i < 5; i++) {
    assert((await loginAs('brutest', 'nope1234')).status === 401, `nonexistent user wrong password -> 401 (attempt ${i + 1})`);
  }
  const brutestLocked = await loginAs('brutest', 'nope1234');
  const brutestLockedBody = await brutestLocked.json();
  assert(brutestLocked.status === 401 && typeof brutestLockedBody.error === 'string' && brutestLockedBody.error.includes('临时锁定'), '6th attempt on nonexistent user reports temporary lock (防枚举)');
  // 2) 真实账号：锁定期间正确密码同样被拒
  assert((await authFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: 'lockuser', name: '锁定测试', password: 'lock123', role: 'reporter' }) })).status === 201, 'create lockuser for lockout test');
  for (let i = 0; i < 5; i++) {
    assert((await loginAs('lockuser', 'badpass')).status === 401, `lockuser wrong password -> 401 (attempt ${i + 1})`);
  }
  const lockCorrect = await loginAs('lockuser', 'lock123');
  const lockCorrectBody = await lockCorrect.json();
  assert(lockCorrect.status === 401 && lockCorrectBody.error.includes('临时锁定'), 'locked account rejected even with correct password');
  // 3) 登录成功清空该账号计数
  assert((await loginAs('admin', 'wrongpw')).status === 401, 'admin single wrong attempt -> 401');
  assert((await loginAs('admin', 'admin123')).status === 200, 'admin login clears failure counter');
  const adminAfterClear = await loginAs('admin', 'wrongpw');
  const adminAfterClearBody = await adminAfterClear.json();
  assert(adminAfterClear.status === 401 && !adminAfterClearBody.error.includes('临时锁定'), 'counter reset after successful login (single failure is not a lock)');

  // ---- 业务 CRUD ----
  const mk = (o) => authFetch('/api/problems', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
  const c1 = await (await mk({ title: 'HIS无法登录', department: '内科', reporter: '张三', type: '故障', severity: '高', description: '内科医生无法登录HIS' })).json();
  assert(c1.id && c1.status === '待处理', 'create #1');
  const c2 = await (await mk({ title: '报表导出需求', department: '财务科', reporter: '李四', type: '需求', severity: '中', description: '需要月度报表', status: '处理中', handler: '王五' })).json();
  assert(c2.id, 'create #2');
  const c3 = await (await mk({ title: 'PACS卡顿咨询', department: '影像科', reporter: '赵六', type: '咨询', severity: '低', description: '问下怎么用' })).json();
  assert(c3.id, 'create #3');

  assert((await mk({ title: 'x' })).status === 400, 'validation rejects incomplete record');

  const list = await (await authFetch('/api/problems?pageSize=10')).json();
  assert(list.total >= 3, 'list total>=3');
  const f = await (await authFetch('/api/problems?type=故障')).json();
  assert(f.total === 1 && f.rows[0].type === '故障', 'filter by type');
  const s = await (await authFetch('/api/problems?keyword=报表')).json();
  assert(s.total === 1, 'keyword search');

  // ---- 排序 ----
  const SEV_RANK = { 低: 1, 中: 2, 高: 3, 紧急: 4 };
  const bySevAsc = await (await authFetch('/api/problems?sort=severity&order=asc&pageSize=50')).json();
  const ranks = bySevAsc.rows.map((r) => SEV_RANK[r.severity] || 9);
  assert(ranks.length >= 3 && ranks.every((v, i) => i === 0 || ranks[i - 1] <= v), 'sort by severity asc follows business rank (低<中<高)');
  const bySevDesc = await (await authFetch('/api/problems?sort=severity&order=desc&pageSize=50')).json();
  assert(bySevDesc.rows[0].severity === '高' && bySevDesc.rows[bySevDesc.rows.length - 1].severity === '低', 'sort by severity desc puts most severe first');
  const byIdAsc = await (await authFetch('/api/problems?sort=id&order=asc&pageSize=50')).json();
  const ids = byIdAsc.rows.map((r) => Number(r.id));
  assert(ids.length >= 3 && ids.every((v, i) => i === 0 || ids[i - 1] <= v), 'sort by id asc');
  const byIdDesc = await (await authFetch('/api/problems?sort=id&order=desc&pageSize=50')).json();
  assert(Number(byIdDesc.rows[0].id) === Math.max(...ids), 'sort by id desc');
  const defList = await (await authFetch('/api/problems?pageSize=50')).json();
  assert(Number(defList.rows[0].id) === Math.max(...ids), 'default sort = newest first (created_at desc, id desc on tie)');
  const badSortRes = await authFetch('/api/problems?sort=created_at%3B%20DROP%20TABLE%20x&order=nonsense');
  assert(badSortRes.status === 200, 'invalid sort/order is ignored (no error)');
  const csvSorted = await (await authFetch('/api/problems/export?format=csv&sort=severity&order=desc')).text();
  assert(
    csvSorted.includes('HIS无法登录') &&
    csvSorted.indexOf('HIS无法登录') < csvSorted.indexOf('PACS卡顿咨询'),
    'export csv respects sort'
  );

  const g = await (await authFetch(`/api/problems/${c1.id}`)).json();
  assert(g.title === 'HIS无法登录', 'get by id');
  const u = await (await authFetch(`/api/problems/${c1.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: '已解决', resolution: '重启服务解决' }),
  })).json();
  assert(u.status === '已解决' && u.resolved_at, 'update to resolved sets resolved_at');
  const st = await (await authFetch('/api/problems/stats')).json();
  assert(st.total >= 3 && (st.byStatus['已解决'] || 0) >= 1, 'stats counts');

  const csvRes = await authFetch('/api/problems/export?format=csv');
  const csv = await csvRes.text();
  assert((csvRes.headers.get('content-type') || '').includes('text/csv') && csv.includes('HIS无法登录'), 'export csv');
  const xlsRes = await authFetch('/api/problems/export?format=xlsx');
  const buf = Buffer.from(await xlsRes.arrayBuffer());
  assert((xlsRes.headers.get('content-type') || '').includes('spreadsheetml') && buf.length > 0, 'export xlsx');

  const del = await (await authFetch(`/api/problems/${c3.id}`, { method: 'DELETE' })).json();
  assert(del.ok === true, 'admin delete problem');
  const afterDel = await (await authFetch('/api/problems')).json();
  assert(afterDel.total === list.total - 1, 'count after delete');

  // ---- 多角色权限 ----
  const cu = await authFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: 'reporter1', name: '登记员一', password: 'rep123', role: 'reporter' }) });
  assert(cu.status === 201, 'admin creates reporter user');

  const rl = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reporter1', password: 'rep123' }),
  });
  const rld = await rl.json();
  assert(rl.status === 200 && rld.user.role === 'reporter', 'reporter login');
  const RTOKEN = rld.token;

  assert((await tokenFetch(RTOKEN, '/api/users')).status === 403, 'reporter cannot access user mgmt -> 403');
  assert((await tokenFetch(RTOKEN, '/api/audit')).status === 403, 'reporter cannot view audit -> 403');

  const rp = await (await tokenFetch(RTOKEN, '/api/problems', { method: 'POST', body: JSON.stringify({ title: '登记员建的问题', department: '内科', reporter: '登记员一', type: '咨询', severity: '低', description: '测试' }) })).json();
  assert(rp.id, 'reporter can create problem');
  assert((await tokenFetch(RTOKEN, `/api/problems/${rp.id}`, { method: 'DELETE' })).status === 403, 'reporter cannot delete problem -> 403');

  // ---- 附件 ----
  const fd = new FormData();
  fd.append('file', new Blob(['hello attachment'], { type: 'text/plain' }), 'note.txt');
  const upRes = await fetch(BASE + `/api/problems/${rp.id}/attachments`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + RTOKEN }, body: fd,
  });
  const att = await upRes.json();
  assert(upRes.status === 201 && att.id && att.originalName === 'note.txt', 'upload attachment');

  const rpGet = await (await tokenFetch(RTOKEN, `/api/problems/${rp.id}`)).json();
  assert(Array.isArray(rpGet.attachments) && rpGet.attachments.length === 1, 'problem has 1 attachment');

  const dlRes = await fetch(BASE + `/api/problems/${rp.id}/attachments/${att.id}`, { headers: { Authorization: 'Bearer ' + RTOKEN } });
  const dlText = await dlRes.text();
  assert(dlRes.status === 200 && dlText.includes('hello attachment'), 'download attachment content');

  assert((await tokenFetch(RTOKEN, `/api/problems/${rp.id}/attachments/${att.id}`, { method: 'DELETE' })).status === 403, 'reporter cannot delete attachment -> 403');
  const aAttDel = await (await authFetch(`/api/problems/${rp.id}/attachments/${att.id}`, { method: 'DELETE' })).json();
  assert(aAttDel.ok === true, 'admin deletes attachment');
  const rpGet2 = await (await authFetch(`/api/problems/${rp.id}`)).json();
  assert((rpGet2.attachments || []).length === 0, 'attachment removed');

  // ---- 删除问题（v1.6 软删除）：附件文件保留；彻底删除才清理磁盘文件 ----
  const fd2 = new FormData();
  fd2.append('file', new Blob(['orphan check'], { type: 'text/plain' }), 'orphan.txt');
  const up2 = await (await fetch(BASE + `/api/problems/${rp.id}/attachments`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + RTOKEN }, body: fd2,
  })).json();
  const orphanPath = path.join(tmpUploads, up2.storedName);
  assert(fs.existsSync(orphanPath), 'attachment file lands on disk');
  assert((await authFetch(`/api/problems/${rp.id}`, { method: 'DELETE' })).status === 200, 'admin deletes problem (soft, into recycle bin)');
  await new Promise((r) => setTimeout(r, 150));
  assert(fs.existsSync(orphanPath), 'soft delete keeps attachment files (restorable)');
  assert((await authFetch(`/api/problems/${rp.id}`)).status === 404, 'soft-deleted problem hidden from detail by default');
  assert((await authFetch(`/api/problems/${rp.id}?deleted=1`)).status === 200, 'soft-deleted problem visible in recycle bin detail (?deleted=1)');
  assert((await authFetch(`/api/problems/${rp.id}/hard`, { method: 'DELETE' })).status === 200, 'hard delete purges the problem');
  await new Promise((r) => setTimeout(r, 150));
  assert(!fs.existsSync(orphanPath), 'hard delete removes its attachment files');

  // ---- 审计日志 ----
  const audit = await (await authFetch('/api/audit?pageSize=200')).json();
  const actions = new Set(audit.rows.map((r) => r.action));
  assert(
    audit.total > 0 && actions.has('LOGIN') && actions.has('CREATE_USER') &&
    actions.has('UPLOAD_ATTACHMENT') && actions.has('CREATE_ISSUE') && actions.has('DELETE_ISSUE'),
    'audit log records key actions'
  );

  // ---- 改密码 / 停用账号 ----
  const usersList = await (await authFetch('/api/users')).json();
  const rep = usersList.find((u) => u.username === 'reporter1');
  assert(rep && rep.active === true, 'reporter in user list with active=true');

  assert((await authFetch(`/api/users/${rep.id}/password`, { method: 'PUT', body: JSON.stringify({ password: 'newpass1' }) })).status === 200, 'admin resets reporter password');
  const loginPw = (pw) => fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reporter1', password: pw }) });
  assert((await loginPw('rep123')).status === 401, 'old password rejected after reset');
  assert((await loginPw('newpass1')).status === 200, 'new password works');

  assert((await authFetch(`/api/users/${rep.id}/status`, { method: 'PUT', body: JSON.stringify({ active: false }) })).status === 200, 'admin disables account');
  assert((await loginPw('newpass1')).status === 403, 'disabled account cannot login -> 403');
  assert((await authFetch(`/api/users/${rep.id}/status`, { method: 'PUT', body: JSON.stringify({ active: true }) })).status === 200, 'admin enables account');
  assert((await loginPw('newpass1')).status === 200, 're-enabled account can login');

  const adminUser = (await (await authFetch('/api/users')).json()).find((u) => u.username === 'admin');
  assert((await authFetch(`/api/users/${adminUser.id}/status`, { method: 'PUT', body: JSON.stringify({ active: false }) })).status === 400, 'cannot disable self -> 400');

  assert((await authFetch('/api/auth/password', { method: 'PUT', body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'admin999' }) })).status === 400, 'change own password with wrong old -> 400');
  assert((await authFetch('/api/auth/password', { method: 'PUT', body: JSON.stringify({ oldPassword: 'admin123', newPassword: 'admin999' }) })).status === 200, 'change own password ok');
  const adminLogin = (pw) => fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pw }) });
  assert((await adminLogin('admin999')).status === 200, 'login with new admin password');
  await authFetch('/api/auth/password', { method: 'PUT', body: JSON.stringify({ oldPassword: 'admin999', newPassword: 'admin123' }) });

  // ---- 审计筛选与导出 ----
  const fAudit = await (await authFetch('/api/audit?action=DELETE_ISSUE')).json();
  assert(fAudit.rows.every((r) => r.action === 'DELETE_ISSUE') && fAudit.total >= 1, 'audit filter by action');
  const uAudit = await (await authFetch('/api/audit?username=admin')).json();
  assert(uAudit.rows.every((r) => r.username === 'admin') && uAudit.total >= 1, 'audit filter by username');
  const rangeAudit = await (await authFetch('/api/audit?from=2000-01-01&to=2999-12-31')).json();
  assert(rangeAudit.total >= 1, 'audit filter by date range');
  const aCsvRes = await authFetch('/api/audit/export?format=csv');
  const aCsv = await aCsvRes.text();
  assert((aCsvRes.headers.get('content-type') || '').includes('text/csv') && aCsv.includes('时间'), 'audit export csv');
  const aXlsRes = await authFetch('/api/audit/export?format=xlsx');
  const aXlsBuf = Buffer.from(await aXlsRes.arrayBuffer());
  assert((aXlsRes.headers.get('content-type') || '').includes('spreadsheetml') && aXlsBuf.length > 0, 'audit export xlsx');

  // ---- 系统名称可配置 ----
  const cfgRes = await fetch(BASE + '/api/config');
  const cfg = await cfgRes.json();
  assert(cfgRes.status === 200 && typeof cfg.appName === 'string' && cfg.appName.length > 0, 'GET /api/config public returns appName');

  const reporterToken2 = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reporter1', password: 'newpass1' }) })).json()).token;
  assert((await tokenFetch(reporterToken2, '/api/settings', { method: 'PUT', body: JSON.stringify({ appName: 'HACK' }) })).status === 403, 'reporter cannot update settings -> 403');
  assert((await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ appName: '   ' }) })).status === 200, 'blank appName accepted but ignored');
  const cfgAfterBlank = await (await fetch(BASE + '/api/config')).json();
  assert(cfgAfterBlank.appName === cfg.appName, 'blank appName does not overwrite');
  // 「无实质变更」不再落审计日志（v1.6 降噪）
  const noiseBefore = (await (await authFetch('/api/audit?action=UPDATE_SETTINGS')).json()).total;
  assert((await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ appName: '   ' }) })).status === 200, 'no-change settings PUT accepted');
  const noiseAfter = (await (await authFetch('/api/audit?action=UPDATE_SETTINGS')).json()).total;
  assert(noiseAfter === noiseBefore, 'no-change settings PUT does not write audit log (无实质变更不落库)');

  const setRes = await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ appName: '海盐县人民医院 · 信息科工单' }) });
  const setBody = await setRes.json();
  assert(setRes.status === 200 && setBody.appName === '海盐县人民医院 · 信息科工单', 'admin updates appName');
  const cfgNew = await (await fetch(BASE + '/api/config')).json();
  assert(cfgNew.appName === '海盐县人民医院 · 信息科工单', 'public config reflects new appName (no restart)');

  // ---- 配置项：处理人 / 软件系统候选名单（v1.18.16：处理人候选改为派生自机构公司用户）----
  const cfgB = await (await fetch(BASE + '/api/config')).json();
  assert(Array.isArray(cfgB.handlers) && Array.isArray(cfgB.softwareSystems), 'GET /api/config returns handlers + softwareSystems arrays');
  const setCfg = await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ handlers: [{ empId: '001', name: '王伟', phone: '13800000000' }, { name: '李娜' }], softwareSystems: ['HIS', 'PACS', 'LIS'] }) });
  const setCfgBody = await setCfg.json();
  // v1.18.16：PUT handlers 仍 200（向后兼容 / 留档，不返回 400），但不影响 config.handlers 的派生来源。
  assert(setCfg.status === 200 && setCfgBody.softwareSystems.length === 3, 'admin PUT settings accepts handlers (deprecated, archive-only) + softwareSystems');
  const cfgA = await (await fetch(BASE + '/api/config')).json();
  // config.handlers 结构保持 { empId, name, phone }（派生自机构公司用户；本测试机构此时尚无 company 用户 → 空数组也是合法派生结果）。
  assert(cfgA.handlers.every((h) => h && typeof h === 'object' && 'name' in h && 'empId' in h && 'phone' in h), 'config handlers keep { empId, name, phone } shape (derived from org company users)');
  assert(!cfgA.handlers.some((h) => h.name === '王伟'), 'config.handlers no longer echoes stored manual list (王伟 absent)');
  assert(cfgA.softwareSystems.includes('HIS'), 'public config reflects new softwareSystems');
  assert((await tokenFetch(reporterToken2, '/api/settings', { method: 'PUT', body: JSON.stringify({ handlers: ['x'] }) })).status === 403, 'reporter cannot update settings -> 403');

  // ---- 用户花名册（登记人下拉，任意已登录用户均可读）----
  const lookup = await (await authFetch('/api/users/lookup')).json();
  assert(Array.isArray(lookup) && lookup.length >= 2 && lookup.every((u) => 'username' in u && 'name' in u), 'GET /api/users/lookup returns {username,name} list for any authed user');
  // v1.18.29：lookup 元素新增 userType（'hospital'|'company'），聊天新建会话按类型分 sheet 页；加法不破坏原键
  assert(lookup.every((u) => u.userType === 'hospital' || u.userType === 'company'), 'GET /api/users/lookup elements carry userType in {hospital,company} (v1.18.29)');
  const reporterLookup = await (await tokenFetch(RTOKEN, '/api/users/lookup')).json();
  assert(Array.isArray(reporterLookup) && reporterLookup.length >= 1, 'reporter can read user lookup (for 登记人 dropdown)');
  // v1.18.29：reporter 侧读取同样带 userType（权限面未变，字段随花名册一致可见）
  assert(reporterLookup.every((u) => u.userType === 'hospital' || u.userType === 'company'), 'reporter lookup also carries userType in {hospital,company} (v1.18.29)');

  // ---- 新建问题携带 登记人 / 处理人 / 软件系统 ----
  const fieldsRec = await (await mk({
    title: '配置字段测试', department: '内科', reporter: '钱七', type: '故障', severity: '中',
    description: '测试登记人/处理人/软件系统', registrar: '孙八', handler: '王伟', softwareSystem: 'HIS',
  })).json();
  assert(fieldsRec.id && fieldsRec.registrar === '孙八' && fieldsRec.softwareSystem === 'HIS' && fieldsRec.handler === '王伟', 'create persists registrar + softwareSystem + handler');
  const fieldsGet = await (await authFetch(`/api/problems/${fieldsRec.id}`)).json();
  assert(fieldsGet.registrar === '孙八' && fieldsGet.softwareSystem === 'HIS', 'new fields persisted on record');

  // ---- 导出包含新列 ----
  const newColCsv = await (await authFetch('/api/problems/export?format=csv')).text();
  assert(newColCsv.split('\n')[1].includes('登记人') && newColCsv.split('\n')[1].includes('软件系统'), 'export includes 登记人 + 软件系统 columns');

  const sAudit = await (await authFetch('/api/audit?action=UPDATE_SETTINGS')).json();
  assert(sAudit.total >= 1 && sAudit.rows.every((r) => r.action === 'UPDATE_SETTINGS'), 'settings change is audited');

  // ---- 批量操作 ----
  const b1 = await (await mk({ title: '批量A', department: '内科', reporter: '甲', type: '故障', severity: '低', description: 'x' })).json();
  const b2 = await (await mk({ title: '批量B', department: '内科', reporter: '乙', type: '需求', severity: '中', description: 'x' })).json();
  const b3 = await (await mk({ title: '批量C', department: '内科', reporter: '丙', type: '其他', severity: '高', description: 'x' })).json();
  const bIds = [b1.id, b2.id, b3.id];

  assert(
    (await authFetch('/api/problems/bulk/status', { method: 'POST', body: JSON.stringify({ ids: [], status: '已解决' }) })).status === 400,
    'bulk status with empty ids -> 400'
  );
  assert(
    (await authFetch('/api/problems/bulk/status', { method: 'POST', body: JSON.stringify({ ids: bIds, status: '不存在的状态' }) })).status === 400,
    'bulk status with illegal status -> 400'
  );

  const bulkOk = await (await authFetch('/api/problems/bulk/status', { method: 'POST', body: JSON.stringify({ ids: [b1.id, b2.id], status: '已解决' }) })).json();
  assert(bulkOk.updated === 2, 'bulk update status affects exactly the selected rows');
  const g1 = await (await authFetch(`/api/problems/${b1.id}`)).json();
  const g2 = await (await authFetch(`/api/problems/${b2.id}`)).json();
  const g3 = await (await authFetch(`/api/problems/${b3.id}`)).json();
  assert(g1.status === '已解决' && !!g1.resolved_at && g2.status === '已解决', 'bulk updated rows get new status + resolved_at');
  assert(g3.status === '待处理' && !g3.resolved_at, 'unselected row is untouched');

  // 直接改回未解决状态应清空 resolved_at
  await authFetch('/api/problems/bulk/status', { method: 'POST', body: JSON.stringify({ ids: [b1.id], status: '处理中' }) });
  const g1b = await (await authFetch(`/api/problems/${b1.id}`)).json();
  assert(g1b.status === '处理中' && !g1b.resolved_at, 'bulk status back to 处理中 clears resolved_at');

  const fd3 = new FormData();
  fd3.append('file', new Blob(['bulk orphan'], { type: 'text/plain' }), 'bulk.txt');
  const up3 = await (await fetch(BASE + `/api/problems/${b3.id}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + RTOKEN }, body: fd3 })).json();
  const bulkOrphan = path.join(tmpUploads, up3.storedName);
  assert(fs.existsSync(bulkOrphan), 'bulk target attachment lands on disk');

  assert(
    (await tokenFetch(RTOKEN, '/api/problems/bulk/delete', { method: 'POST', body: JSON.stringify({ ids: bIds }) })).status === 403,
    'reporter cannot bulk delete -> 403'
  );
  const bulkDel = await (await authFetch('/api/problems/bulk/delete', { method: 'POST', body: JSON.stringify({ ids: bIds }) })).json();
  assert(bulkDel.deleted === 3, 'admin bulk delete (soft) moves 3 rows into recycle bin');
  await new Promise((r) => setTimeout(r, 150));
  assert(fs.existsSync(bulkOrphan), 'bulk soft delete keeps attachment files (restorable)');
  assert((await authFetch(`/api/problems/${b1.id}`)).status === 404, 'bulk deleted record is gone from normal detail');
  const bulkBin = await (await authFetch('/api/problems?deleted=1&pageSize=50')).json();
  assert(bulkBin.rows.some((r) => r.id === b1.id) && bulkBin.rows.some((r) => r.id === b3.id), 'bulk deleted records visible in recycle bin');
  // 彻底删除其中一条（b3 持有附件）：附件文件被清理
  assert((await authFetch(`/api/problems/${b3.id}/hard`, { method: 'DELETE' })).status === 200, 'hard delete purges b3 from recycle bin');
  await new Promise((r) => setTimeout(r, 150));
  assert(!fs.existsSync(bulkOrphan), 'hard delete cleans attachment files from disk');

  const bAudit = await (await authFetch('/api/audit?pageSize=50')).json();
  const bActions = new Set(bAudit.rows.map((r) => r.action));
  assert(bActions.has('BULK_UPDATE_STATUS') && bActions.has('BULK_DELETE_ISSUE'), 'bulk actions are audited');

  // ---- 导出携带筛选 / 排序说明 ----
  const condCsv = await (await authFetch('/api/problems/export?format=csv&type=' + encodeURIComponent('故障') + '&sort=severity&order=desc')).text();
  assert(condCsv.includes('导出条件'), 'export csv has condition line');
  assert(condCsv.includes('问题类型=故障') && condCsv.includes('严重程度 降序'), 'export csv describes current filter + sort');
  const plainCsv = await (await authFetch('/api/problems/export?format=csv')).text();
  assert(plainCsv.includes('全部数据'), 'export csv says 全部数据 when unfiltered');

  // XLSX 结构：第 1 行说明、第 2 行空行、第 3 行表头、第 4 行起为数据（防止 ws.columns 覆盖说明行的回归）
  const xlsxCondRes = await authFetch('/api/problems/export?format=xlsx&type=' + encodeURIComponent('故障'));
  const xlsxBuf = Buffer.from(await xlsxCondRes.arrayBuffer());
  const condWb = new ExcelJS.Workbook();
  await condWb.xlsx.load(xlsxBuf);
  const condWs = condWb.worksheets[0];
  assert(String(condWs.getRow(1).getCell(1).value || '').includes('导出条件'), 'export xlsx: row 1 is the condition note');
  assert(condWs.getRow(3).getCell(1).value === 'ID' && condWs.getRow(3).getCell(2).value === '问题标题', 'export xlsx: header row is row 3');
  assert(typeof condWs.getRow(4).getCell(1).value === 'number', 'export xlsx: data starts at row 4');
  assert((condWs.views || []).some((v) => v.state === 'frozen' && v.ySplit === 3), 'export xlsx: rows frozen above the table');

  // ---- 满意度回访 ----
  const sp = await (await authFetch('/api/problems', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '回访测试问题', department: '内科', reporter: '钱七', type: '故障', severity: '中', description: '用于回访测试', status: '已解决', resolution: '已处理' }),
  })).json();
  assert(sp.id && sp.createdBy === 'admin', 'createdBy injected from login user (admin)');
  // 非登记人、非管理员打分 -> 403
  const rateByReporter = await tokenFetch(RTOKEN, `/api/problems/${sp.id}/satisfaction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ satisfaction: '满意', feedback: '很好' }),
  });
  assert(rateByReporter.status === 403, 'reporter cannot rate someone else\'s issue -> 403');
  // 非法满意度取值 -> 400
  assert((await authFetch(`/api/problems/${sp.id}/satisfaction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ satisfaction: '很满意' }),
  })).status === 400, 'illegal satisfaction value -> 400');
  // 登记人（admin 本人）打分 -> 200
  const rated = await (await authFetch(`/api/problems/${sp.id}/satisfaction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ satisfaction: '满意', feedback: '处理及时' }),
  })).json();
  assert(rated.satisfaction === '满意' && rated.rated_at, 'owner rates satisfaction; rated_at set');
  const spGet = await (await authFetch(`/api/problems/${sp.id}`)).json();
  assert(spGet.satisfaction === '满意' && spGet.rated_at, 'satisfaction persisted on record');
  const stAfter = await (await authFetch('/api/problems/stats')).json();
  assert((stAfter.bySatisfaction['满意'] || 0) >= 1, 'stats includes bySatisfaction');
  // 清空回访 -> 满意度置空、rated_at 置空
  const cleared = await (await authFetch(`/api/problems/${sp.id}/satisfaction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ satisfaction: '', feedback: '' }),
  })).json();
  assert(cleared.satisfaction === '' && !cleared.rated_at, 'clearing satisfaction empties rated_at');

  // ---- 趋势聚合 ----
  const trendRes = await (await authFetch('/api/problems/trend')).json();
  assert(Array.isArray(trendRes.byDepartment) && Array.isArray(trendRes.byMonth), 'trend returns byDepartment + byMonth arrays');
  const trendTotal = trendRes.byDepartment.reduce((s, d) => s + (d.count || 0), 0);
  assert(trendTotal === trendRes.byDepartment.reduce((s, d) => s + d.count, 0) && trendTotal >= 1, 'trend byDepartment counts sum matches entries');
  assert(trendRes.byMonth.every((m, i, arr) => i === 0 || arr[i - 1].month <= m.month), 'trend byMonth sorted ascending');

  // ---- 导出可选字段（字段白名单）----
  const fcsv = await (await authFetch('/api/problems/export?format=csv&fields=' + encodeURIComponent('title') + '&fields=' + encodeURIComponent('department'))).text();
  const fcsvLines = fcsv.split('\n');
  assert(fcsv.includes('导出字段：问题标题、所属科室'), 'export condition note lists chosen fields');
  assert(fcsvLines[1].includes('问题标题') && fcsvLines[1].includes('所属科室') && !fcsvLines[1].includes('严重程度'), 'csv header limited to selected fields');
  // 非法字段被忽略 -> 回退到全部列
  const badFields = await (await authFetch('/api/problems/export?format=csv&fields=' + encodeURIComponent('__hack__'))).text();
  assert(badFields.split('\n')[1].includes('严重程度'), 'illegal field ignored -> falls back to all columns');
  // XLSX 按字段子集导出：仅 1 列
  const fxls = await authFetch('/api/problems/export?format=xlsx&fields=' + encodeURIComponent('title'));
  const fxlsBuf = Buffer.from(await fxls.arrayBuffer());
  const fxlsWb = new ExcelJS.Workbook();
  await fxlsWb.xlsx.load(fxlsBuf);
  const fxlsWs = fxlsWb.worksheets[0];
  assert(fxlsWs.getRow(3).getCell(1).value === '问题标题' && (fxlsWs.columnCount || 1) === 1, 'xlsx export respects field subset (single column)');

  // ---- 满意度字段已进入导出列 ----
  const satCsv = await (await authFetch('/api/problems/export?format=csv')).text();
  assert(satCsv.split('\n')[1].includes('满意度'), 'export includes 满意度 column by default');

  // ---- 角色权限：/api/config 暴露权限表 ----
  const cfgPerm = await (await fetch(BASE + '/api/config')).json();
  assert(!!cfgPerm.permissions && !!cfgPerm.permissions.admin && !!cfgPerm.permissions.reporter, 'GET /api/config exposes permissions for admin + reporter');
  assert(
    Array.isArray(cfgPerm.permissions.reporter.menus) && typeof cfgPerm.permissions.reporter.actions['issue.create'] === 'boolean',
    'permissions shape: menus array + actions booleans'
  );
  assert(
    cfgPerm.permissions.reporter.actions['user.manage'] === false && cfgPerm.permissions.admin.actions['user.manage'] === true,
    'default: reporter cannot manage users, admin can'
  );

  // 权限变更即时生效（无需重启）：授予 reporter 查看操作日志 -> 200
  const permPayload = (patch) => ({
    permissions: {
      admin: cfgPerm.permissions.admin,
      reporter: { ...cfgPerm.permissions.reporter, ...patch },
    },
  });
  const grantAudit = await authFetch('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(permPayload({ actions: { ...cfgPerm.permissions.reporter.actions, 'audit.view': true } })),
  });
  assert(grantAudit.status === 200, 'admin grants reporter audit.view');
  const rToken3 = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reporter1', password: 'newpass1' }) })).json()).token;
  assert((await tokenFetch(rToken3, '/api/audit')).status === 200, 'granted reporter can now read audit (permission takes effect immediately)');

  // 收回 -> 403
  await authFetch('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(permPayload({ actions: { ...cfgPerm.permissions.reporter.actions, 'audit.view': false } })),
  });
  assert((await tokenFetch(rToken3, '/api/audit')).status === 403, 'revoked reporter loses audit access -> 403');

  // 收回 reporter 登记问题权限 -> 403
  await authFetch('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(permPayload({ actions: { ...cfgPerm.permissions.reporter.actions, 'issue.create': false } })),
  });
  assert(
    (await tokenFetch(rToken3, '/api/problems', { method: 'POST', body: JSON.stringify({ title: '被拒', department: '内科', reporter: '登记员一', type: '咨询', severity: '低', description: 'x' }) })).status === 403,
    'reporter without issue.create is blocked -> 403'
  );
  // 恢复 -> 201
  await authFetch('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(permPayload({ actions: { ...cfgPerm.permissions.reporter.actions, 'issue.create': true } })),
  });
  assert(
    (await tokenFetch(rToken3, '/api/problems', { method: 'POST', body: JSON.stringify({ title: '权限恢复后可建', department: '内科', reporter: '登记员一', type: '咨询', severity: '低', description: 'x' }) })).status === 201,
    'restoring issue.create lets reporter create again'
  );

  // 授予 reporter 修改系统设置 -> 200
  await authFetch('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(permPayload({ actions: { ...cfgPerm.permissions.reporter.actions, 'settings.edit': true } })),
  });
  assert((await tokenFetch(rToken3, '/api/settings', { method: 'PUT', body: JSON.stringify({ appName: '权限测试名' }) })).status === 200, 'granted reporter can update settings');

  // 非法权限输入被归一化：非法菜单 key 丢弃、非布尔动作回落默认、非法动作 key 丢弃、缺失角色保留
  const normRes = await authFetch('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ permissions: { reporter: { menus: ['users', '__bogus__'], actions: { 'issue.create': 'not-a-bool', 'bogus.action': true } } } }),
  });
  const normBody = await normRes.json();
  assert(normRes.status === 200, 'malformed permissions payload accepted (normalized)');
  assert(normBody.permissions.reporter.menus.includes('users') && !normBody.permissions.reporter.menus.includes('__bogus__'), 'illegal menu key dropped, valid one kept');
  assert(normBody.permissions.reporter.actions['issue.create'] === true, 'non-boolean action falls back to default');
  assert(!('bogus.action' in normBody.permissions.reporter.actions), 'unknown action key dropped');
  assert(!!normBody.permissions.admin && Array.isArray(normBody.permissions.admin.menus) && normBody.permissions.admin.menus.includes('settings'), 'missing role filled from defaults (admin intact)');

  // 恢复默认权限，保持环境干净
  const restore = await (await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ permissions: { admin: cfgPerm.permissions.admin, reporter: cfgPerm.permissions.reporter } }) })).json();
  assert(restore.permissions.reporter.actions['user.manage'] === false && restore.permissions.reporter.actions['audit.view'] === false, 'defaults restored after permission tests');
  const cfgFinal = await (await fetch(BASE + '/api/config')).json();
  assert(cfgFinal.permissions.reporter.menus.join(',') === cfgPerm.permissions.reporter.menus.join(','), 'config reflects restored permissions');

  // ---- v1.18.16：名单 PUT 仍可存储（handlers 留档），但 config.handlers 派生自机构公司用户，不随其增删变化 ----
  const listPut = await (await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ handlers: ['王伟', '李娜', '张强'], softwareSystems: ['HIS', 'PACS'] }) })).json();
  assert(listPut.handlers.length === 3 && listPut.softwareSystems.length === 2, 'list-style update persists both lists (handlers stored for archive only)');
  const listPut2 = await (await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ handlers: ['王伟'], softwareSystems: ['HIS'] }) })).json();
  assert(listPut2.handlers.length === 1 && listPut2.softwareSystems.length === 1, 'removing list items persists immediately');
  const cfgList = await (await fetch(BASE + '/api/config')).json();
  assert(!cfgList.handlers.some((h) => h.name === '王伟') && cfgList.softwareSystems.length === 1, 'config.handlers unaffected by manual list changes (derived from org company users, softwareSystems still live)');

  // ---- v2：数据驾驶舱多维度 ----
  // 为得到确定性数值：先清空既有问题，再灌入一组「已知数据」，逐项与手算值比对。
  const preDash = await (await authFetch('/api/problems?pageSize=500')).json();
  if (preDash.rows.length) {
    assert((await authFetch('/api/problems/bulk/delete', { method: 'POST', body: JSON.stringify({ ids: preDash.rows.map((r) => r.id) }) })).status === 200, 'dashboard prep: clear existing problems');
  }

  // 空库边界：三类比值必须为 0（不是 NaN/null）
  const emptyDash = await (await authFetch('/api/problems/dashboard')).json();
  assert(emptyDash.kpi.total === 0, 'dashboard empty: total=0');
  assert(emptyDash.kpi.resolvedRate === 0 && emptyDash.kpi.satisfactionRate === 0 && emptyDash.kpi.avgResolveHours === 0, 'dashboard empty: resolvedRate/satisfactionRate/avgResolveHours === 0');
  assert(Number.isFinite(emptyDash.kpi.resolvedRate) && emptyDash.kpi.resolvedRate !== null && Number.isFinite(emptyDash.kpi.satisfactionRate) && Number.isFinite(emptyDash.kpi.avgResolveHours), 'dashboard empty: 比值是数字(非 NaN/null)');

  // 已知数据（5 条，覆盖 4 种状态 + 3 种满意度 + 多科室/处理人/软件系统）
  await mk({ title: 'K1', department: '内科', reporter: '甲', type: '故障', severity: '高', description: 'd' });
  await mk({ title: 'K2', department: '财务科', reporter: '乙', type: '需求', severity: '中', description: 'd', status: '处理中', handler: '王五', softwareSystem: 'PACS' });
  await mk({ title: 'K3', department: '影像科', reporter: '丙', type: '咨询', severity: '低', description: 'd', status: '已解决', handler: '王五', softwareSystem: 'HIS', satisfaction: '满意' });
  await mk({ title: 'K4', department: '内科', reporter: '丁', type: '其他', severity: '紧急', description: 'd', status: '已关闭', handler: '李四', satisfaction: '一般' });
  await mk({ title: 'K5', department: '财务科', reporter: '戊', type: '故障', severity: '中', description: 'd', status: '已解决', handler: '李四', softwareSystem: 'PACS', satisfaction: '不满意' });

  const dRes = await authFetch('/api/problems/dashboard');
  const dash = await dRes.json();
  assert(dRes.status === 200 && dash.kpi && typeof dash.kpi.total === 'number', 'dashboard returns kpi with numeric total');
  // 数值逐项与手算一致
  assert(dash.kpi.total === 5, 'dashboard kpi.total === 5');
  assert(dash.kpi.pending === 2, 'dashboard kpi.pending === 2 (待处理1+处理中1)');
  assert(dash.kpi.resolved === 2, 'dashboard kpi.resolved === 2');
  assert(dash.kpi.closed === 1, 'dashboard kpi.closed === 1');
  assert(dash.kpi.resolvedRate === 60, 'dashboard kpi.resolvedRate === 60 (=(2+1)/5)');
  assert(dash.kpi.satisfactionRate === 33.3, 'dashboard kpi.satisfactionRate === 33.3 (=1/3 四舍五入 1 位)');
  assert(dash.kpi.avgResolveHours === 0, 'dashboard kpi.avgResolveHours === 0 (创建即解决的同期记录)');
  assert(dash.kpi.ratedCount === 3, 'dashboard kpi.ratedCount === 3');
  assert(dash.kpi.departmentCount === 3, 'dashboard kpi.departmentCount === 3');
  assert(dash.kpi.handlerCount === 2, 'dashboard kpi.handlerCount === 2');
  assert(dash.kpi.softwareSystemCount === 2, 'dashboard kpi.softwareSystemCount === 2');
  assert(dash.kpi.monthCount === 5 && dash.kpi.lastMonthCount === 0 && dash.kpi.monthDelta === 5, 'dashboard kpi.monthCount=5/lastMonth=0/delta=5');
  // 结构不变量（固定顺序 + 补零）
  assert(Array.isArray(dash.byStatus) && dash.byStatus.length === 4, 'dashboard byStatus has 4 fixed buckets');
  assert(dash.byStatus.reduce((s, x) => s + x.count, 0) === dash.kpi.total, 'dashboard byStatus counts sum equals total');
  assert(JSON.stringify(dash.byStatus) === JSON.stringify([{ status: '待处理', count: 1 }, { status: '处理中', count: 1 }, { status: '已解决', count: 2 }, { status: '已关闭', count: 1 }]), 'dashboard byStatus 固定顺序+补零');
  assert(JSON.stringify(dash.byType) === JSON.stringify([{ type: '故障', count: 2 }, { type: '需求', count: 1 }, { type: '咨询', count: 1 }, { type: '其他', count: 1 }]), 'dashboard byType 固定顺序+补零');
  assert(JSON.stringify(dash.bySeverity) === JSON.stringify([{ severity: '低', count: 1 }, { severity: '中', count: 2 }, { severity: '高', count: 1 }, { severity: '紧急', count: 1 }]), 'dashboard bySeverity 固定顺序+补零');
  assert(JSON.stringify(dash.bySatisfaction) === JSON.stringify([{ name: '满意', count: 1 }, { name: '一般', count: 1 }, { name: '不满意', count: 1 }]), 'dashboard bySatisfaction 固定顺序+补零');
  assert(Array.isArray(dash.byMonth) && dash.byMonth.length === 12 && dash.byMonth.every((m, i, a) => i === 0 || a[i - 1].month < m.month), 'dashboard byMonth 12 项升序');
  assert(Array.isArray(dash.byRecentDays) && dash.byRecentDays.length === 14 && dash.byRecentDays.every((x, i, a) => i === 0 || a[i - 1].date < x.date), 'dashboard byRecentDays 14 项升序');
  assert(Array.isArray(dash.byDepartment) && Array.isArray(dash.byHandler) && Array.isArray(dash.bySoftwareSystem), 'dashboard has dept/handler/system dimensions');
  const hMap = Object.fromEntries(dash.byHandler.map((x) => [x.handler, x.count]));
  assert(hMap['王五'] === 2 && hMap['李四'] === 2, 'dashboard byHandler 计数正确');
  const deptMap = Object.fromEntries(dash.byDepartment.map((x) => [x.department, x.count]));
  assert(deptMap['内科'] === 2 && deptMap['财务科'] === 2 && deptMap['影像科'] === 1, 'dashboard byDepartment 计数正确');

  // ---- v2：角色动态化 ----
  const cfgRoles = await (await fetch(BASE + '/api/config')).json();
  assert(Array.isArray(cfgRoles.roles) && cfgRoles.roles.some((r) => r.key === 'admin' && r.builtin === true) && cfgRoles.roles.some((r) => r.key === 'reporter'), 'config exposes roles incl builtin admin/reporter');
  assert(cfgRoles.permissions.admin.actions['issue.rateAll'] === true && cfgRoles.permissions.reporter.actions['issue.rateAll'] === false, 'issue.rateAll defaults: admin only');
  const permKeys = Object.keys(cfgRoles.permissions).slice().sort();
  const roleKeys = cfgRoles.roles.map((r) => r.key).slice().sort();
  assert(permKeys.length === roleKeys.length && permKeys.every((k, i) => k === roleKeys[i]), 'config: Object.keys(permissions) 与 roles keys 集合完全相等');

  const addRoleRes = await authFetch('/api/settings', {
    method: 'PUT', body: JSON.stringify({ roles: [
      { key: 'admin', label: '管理员' }, { key: 'reporter', label: '登记员' }, { key: 'reviewer', label: '回访专员' },
    ] }),
  });
  assert(addRoleRes.status === 200, 'add custom role reviewer');
  const cfgWithRole = await (await fetch(BASE + '/api/config')).json();
  assert(cfgWithRole.roles.some((r) => r.key === 'reviewer' && r.builtin === false) && !!cfgWithRole.permissions.reviewer, 'custom role persisted with default permissions');
  const rvPerm = cfgWithRole.permissions.reviewer;
  const RV_TRUE = ['issue.create', 'issue.edit', 'issue.bulkStatus', 'issue.export', 'issue.rate', 'chat.use'];
  const RV_FALSE = ['issue.delete', 'issue.bulkDelete', 'user.manage', 'audit.view', 'settings.edit', 'issue.rateAll', 'notification.send', 'notification.broadcast'];
  // v1.18.40: timesheet 菜单新增；v1.18.43: tsconfig（工时配置）菜单新增 —— 登记员模板 menus 同步（动作数 16 个不变）
  assert(
    JSON.stringify(rvPerm.menus) === JSON.stringify(['dashboard', 'issues', 'audited', 'kb', 'schedule', 'chat', 'timesheet', 'tsconfig']) &&
    RV_TRUE.every((a) => rvPerm.actions[a] === true) && RV_FALSE.every((a) => rvPerm.actions[a] === false),
    'new role default permissions === 登记员模板（menus=[dashboard,issues,audited,kb,schedule,chat,timesheet,tsconfig] + 16 个动作）'
  );

  const rvRes = await authFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: 'reviewer1', name: '回访员', password: 'rv1234', role: 'reviewer' }) });
  const rvUser = await rvRes.json();
  assert(rvRes.status === 201 && rvUser.role === 'reviewer', 'create user with custom role');
  assert((await authFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: 'x1', password: 'xxxxxx', role: 'nope' }) })).status === 400, 'unknown role rejected on create user');
  assert((await authFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: 'hack1', password: 'hack123', role: '__hack__' }) })).status === 400, "role '__hack__' rejected on create user -> 400");

  const repRow = (await (await authFetch('/api/users')).json()).find((u) => u.username === 'reporter1');
  assert((await authFetch('/api/users/' + repRow.id + '/role', { method: 'PUT', body: JSON.stringify({ role: 'reviewer' }) })).status === 200, 'switch user role to custom role');
  assert((await (await authFetch('/api/users')).json()).find((u) => u.id === repRow.id).role === 'reviewer', 'user role persisted after switch');
  await authFetch('/api/users/' + repRow.id + '/role', { method: 'PUT', body: JSON.stringify({ role: 'reporter' }) });
  assert((await authFetch('/api/users/' + repRow.id + '/role', { method: 'PUT', body: JSON.stringify({ role: '__hack__' }) })).status === 400, "PUT /api/users/:id/role with illegal role '__hack__' -> 400");

  // 动态授权闭环：给新角色 reviewer 开 user.manage，用该角色登录验证「即时生效」+ 收回后 403
  const cfgR = await (await fetch(BASE + '/api/config')).json();
  const grantR = JSON.parse(JSON.stringify(cfgR.permissions));
  grantR.reviewer.actions['user.manage'] = true;
  assert((await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ permissions: grantR }) })).status === 200, 'grant custom role reviewer user.manage -> 200');
  const rvToken = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reviewer1', password: 'rv1234' }) })).json()).token;
  assert((await tokenFetch(rvToken, '/api/users')).status === 200, 'reviewer with user.manage can GET /api/users -> 200');
  const revokeR = JSON.parse(JSON.stringify(cfgR.permissions));
  revokeR.reviewer.actions['user.manage'] = false;
  await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ permissions: revokeR }) });
  assert((await tokenFetch(rvToken, '/api/users')).status === 403, 'reviewer after revoke loses /api/users -> 403');

  const builtinRolesOnly = JSON.stringify({ roles: [ { key: 'admin', label: '管理员' }, { key: 'reporter', label: '登记员' } ] });
  const delUsedRes = await authFetch('/api/settings', { method: 'PUT', body: builtinRolesOnly });
  const delUsedBody = await delUsedRes.json();
  assert(delUsedRes.status === 400, 'cannot delete a role still used by users -> 400');
  assert(typeof delUsedBody.error === 'string' && /[\u4e00-\u9fa5]/.test(delUsedBody.error) && (delUsedBody.error.includes('角色') || delUsedBody.error.includes('用户')), 'role-in-use 400 error 含可读中文关键词');
  await authFetch('/api/users/' + rvUser.id + '/role', { method: 'PUT', body: JSON.stringify({ role: 'reporter' }) });
  assert((await authFetch('/api/settings', { method: 'PUT', body: builtinRolesOnly })).status === 200, 'role removable once no user references it');
  assert((await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ roles: [ { key: 'reporter', label: '登记员' } ] }) })).status === 400, 'builtin role cannot be removed -> 400');

  // 锁死保护：关闭所有角色的用户管理/修改系统设置 -> 400
  const cfgNow = await (await fetch(BASE + '/api/config')).json();
  const lockedPerms = JSON.parse(JSON.stringify(cfgNow.permissions));
  for (const rk of Object.keys(lockedPerms)) { lockedPerms[rk].actions['user.manage'] = false; lockedPerms[rk].actions['settings.edit'] = false; }
  const lockRes = await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ permissions: lockedPerms }) });
  const lockBody = await lockRes.json();
  assert(lockRes.status === 400, 'lock protection: no privileged role -> 400');
  assert(typeof lockBody.error === 'string' && /[\u4e00-\u9fa5]/.test(lockBody.error) && (lockBody.error.includes('至少') || lockBody.error.includes('角色')), 'lock-protection 400 error 含可读中文关键词');

  const roleAudit = await (await authFetch('/api/audit?action=UPDATE_USER_ROLE')).json();
  assert(roleAudit.total >= 1 && roleAudit.rows.every((r) => r.action === 'UPDATE_USER_ROLE'), 'role change is audited (UPDATE_USER_ROLE)');

  // 恢复默认权限，保持环境干净
  await authFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ permissions: { admin: cfgNow.permissions.admin, reporter: cfgNow.permissions.reporter } }) });

  // ---- v4：消息通知 ----
  const cfgNotify = await (await fetch(BASE + '/api/config')).json();
  assert(
    cfgNotify.permissions.admin.actions['notification.send'] === true && cfgNotify.permissions.admin.actions['notification.broadcast'] === true,
    'admin 默认可发送通知 / 全员通知（/api/config）'
  );
  assert(
    cfgNotify.permissions.reporter.actions['notification.send'] === false && cfgNotify.permissions.reporter.actions['notification.broadcast'] === false,
    'reporter 默认不可发送通知（/api/config）'
  );

  // admin 给 reporter1 发单条
  const sendOne = await (await authFetch('/api/notifications', { method: 'POST', body: JSON.stringify({ title: '单条通知A', body: '正文A', to: ['reporter1'] }) })).json();
  assert(sendOne.sent === 1, 'admin 发送单条通知 -> sent=1');

  const repList = await (await tokenFetch(rToken3, '/api/notifications')).json();
  assert(Array.isArray(repList.rows) && repList.rows.some((m) => m.title === '单条通知A'), 'reporter1 列表可见该通知');
  assert(repList.unread >= 1, 'reporter1 未读数 ≥ 1');
  assert(
    repList.rows.every((m) => m.to === 'reporter1' && typeof m.read === 'boolean' && 'from' in m && 'broadcast' in m),
    '列表仅返回本人通知且统一字段齐全（from/to/read/broadcast）'
  );

  const uc1 = await (await tokenFetch(rToken3, '/api/notifications/unread-count')).json();
  assert(uc1.unread === repList.unread, '/unread-count 与列表 unread 一致');

  const oneMsg = repList.rows.find((m) => m.title === '单条通知A');
  assert((await tokenFetch(rToken3, `/api/notifications/${oneMsg.id}/read`, { method: 'PUT' })).status === 200, '标记单条已读 -> 200');
  const uc2 = await (await tokenFetch(rToken3, '/api/notifications/unread-count')).json();
  assert(uc2.unread === uc1.unread - 1, '标记已读后未读 -1');
  const readAgain = await tokenFetch(rToken3, `/api/notifications/${oneMsg.id}/read`, { method: 'PUT' });
  const uc3 = await (await tokenFetch(rToken3, '/api/notifications/unread-count')).json();
  assert(readAgain.status === 200 && uc3.unread === uc2.unread, '重复标记已读幂等（未读不变）');

  // 再发一条，供 read-all 使用
  await authFetch('/api/notifications', { method: 'POST', body: JSON.stringify({ title: '单条通知B', body: '正文B', to: ['reporter1'] }) });

  // 越权：reporter1 用 admin 的消息 id 标记已读 -> 404（不泄漏他人消息是否存在）
  const toAdmin = await (await authFetch('/api/notifications', { method: 'POST', body: JSON.stringify({ title: '仅给管理员', body: 'x', to: ['admin'] }) })).json();
  assert(toAdmin.sent === 1, 'admin 发给自己 -> sent=1');
  const adminMsg = (await (await authFetch('/api/notifications')).json()).rows.find((m) => m.title === '仅给管理员');
  assert((await tokenFetch(rToken3, `/api/notifications/${adminMsg.id}/read`, { method: 'PUT' })).status === 404, '越权标记他人消息 -> 404');

  // 全部已读
  const readAll = await (await tokenFetch(rToken3, '/api/notifications/read-all', { method: 'PUT' })).json();
  assert(readAll.ok === true && readAll.updated >= 1, 'PUT /read-all -> ok 且 updated≥1');
  const uc0 = await (await tokenFetch(rToken3, '/api/notifications/unread-count')).json();
  assert(uc0.unread === 0, '全部已读后未读为 0');

  // 全员广播：sent = 启用用户数，且每个启用用户未读 +1
  const activeUsers = (await (await authFetch('/api/users')).json()).filter((u) => u.active !== false);
  const beforeAdminUnread = (await (await authFetch('/api/notifications/unread-count')).json()).unread;
  const bc = await (await authFetch('/api/notifications/broadcast', { method: 'POST', body: JSON.stringify({ title: '全员通知', body: '广播正文' }) })).json();
  assert(bc.sent === activeUsers.length, '全员广播 sent 等于启用用户数');
  const bcAdminList = await (await authFetch('/api/notifications')).json();
  const bcAdminMsg = bcAdminList.rows.find((m) => m.title === '全员通知');
  assert(bcAdminMsg && bcAdminMsg.broadcast === true, '广播记录 broadcast=true');
  assert(bcAdminList.unread === beforeAdminUnread + 1, 'admin 广播后未读 +1');
  const repUnreadAfterBc = await (await tokenFetch(rToken3, '/api/notifications/unread-count')).json();
  assert(repUnreadAfterBc.unread === 1, 'reporter1 广播后未读 +1（=1）');

  // 无权限：reporter 调 POST / 与 /broadcast -> 403
  assert((await tokenFetch(rToken3, '/api/notifications', { method: 'POST', body: JSON.stringify({ title: 'x', body: 'y', to: ['admin'] }) })).status === 403, 'reporter 无权限发送通知 -> 403');
  assert((await tokenFetch(rToken3, '/api/notifications/broadcast', { method: 'POST', body: JSON.stringify({ title: 'x', body: 'y' }) })).status === 403, 'reporter 无权限广播 -> 403');

  // 参数校验
  assert((await authFetch('/api/notifications', { method: 'POST', body: JSON.stringify({ body: '无标题', to: ['reporter1'] }) })).status === 400, '缺 title -> 400');
  assert((await authFetch('/api/notifications', { method: 'POST', body: JSON.stringify({ title: 't', body: 'b', to: ['no_such_user'] }) })).status === 400, 'to 不存在用户 -> 400');
  assert((await authFetch('/api/notifications', { method: 'POST', body: JSON.stringify({ title: 't', body: 'b', to: 'all' }) })).status === 400, "to='all' -> 400（应走全员接口）");

  // 审计
  const sendAudit = await (await authFetch('/api/audit?action=SEND_NOTIFICATION')).json();
  assert(sendAudit.total >= 1 && sendAudit.rows.every((r) => r.action === 'SEND_NOTIFICATION'), '审计含 SEND_NOTIFICATION');
  const bcAudit = await (await authFetch('/api/audit?action=BROADCAST_NOTIFICATION')).json();
  assert(bcAudit.total >= 1 && bcAudit.rows.every((r) => r.action === 'BROADCAST_NOTIFICATION'), '审计含 BROADCAST_NOTIFICATION');

  // ---- v1.6：审核不通过原因限长（200 字）----
  const ar = await (await mk({ title: '审核限长测试', department: '内科', reporter: '甲', type: '故障', severity: '低', description: 'd' })).json();
  assert((await authFetch(`/api/problems/${ar.id}/audit`, { method: 'POST', body: JSON.stringify({ result: 'reject', reason: '长'.repeat(201) }) })).status === 400, 'reject reason 201 chars -> 400');
  const arOk = await (await authFetch(`/api/problems/${ar.id}/audit`, { method: 'POST', body: JSON.stringify({ result: 'reject', reason: '长'.repeat(200) }) })).json();
  assert(arOk.audit_status === '不通过' && arOk.audit_reason.length === 200, 'reject reason exactly 200 chars accepted');

  // ---- v1.6：问题回收站（软删除）----
  // 基线：正常列表（此前批量软删的记录均在回收站，不含在正常列表内）
  const baseList = await (await authFetch('/api/problems?pageSize=100')).json();
  const binList0 = await (await authFetch('/api/problems?deleted=1&pageSize=100')).json();
  assert(binList0.total >= 2, 'recycle bin holds earlier soft-deleted records');
  assert(!baseList.rows.some((r) => r.id === b2.id) && !baseList.rows.some((r) => r.id === b3.id), 'normal list excludes recycled records');
  assert((await tokenFetch(RTOKEN, '/api/problems?deleted=1')).status === 403, 'reporter cannot view recycle bin -> 403');

  const rb = await (await mk({ title: '回收站测试工单', department: '内科', reporter: '甲', type: '故障', severity: '中', description: 'd' })).json();
  assert(rb.id, 'create recycle-bin test record');
  assert((await authFetch(`/api/problems/${rb.id}`, { method: 'DELETE' })).status === 200, 'soft delete -> 200');

  // 软删后：列表 / 详情 / 统计 / 趋势 / 驾驶舱 / 导出 均不含
  const afterDelList = await (await authFetch('/api/problems?pageSize=100')).json();
  assert(!afterDelList.rows.some((r) => r.id === rb.id), 'normal list excludes soft-deleted record');
  assert((await authFetch(`/api/problems/${rb.id}`)).status === 404, 'soft-deleted detail -> 404 by default');
  assert((await authFetch(`/api/problems/${rb.id}?deleted=1`)).status === 200, 'soft-deleted detail visible with ?deleted=1');
  const binList1 = await (await authFetch('/api/problems?deleted=1&pageSize=100')).json();
  assert(binList1.rows.some((r) => r.id === rb.id), 'recycle bin shows soft-deleted record');
  const statsDel = await (await authFetch('/api/problems/stats')).json();
  assert(statsDel.total === baseList.total, 'stats excludes soft-deleted records');
  const dashDel = await (await authFetch('/api/problems/dashboard')).json();
  assert(dashDel.kpi.total === baseList.total, 'dashboard excludes soft-deleted records');
  const trendDel = await (await authFetch('/api/problems/trend')).json();
  assert(trendDel.byDepartment.reduce((s, x) => s + x.count, 0) === baseList.total, 'trend excludes soft-deleted records');
  const csvDel = await (await authFetch('/api/problems/export?format=csv')).text();
  assert(!csvDel.includes('回收站测试工单'), 'export excludes soft-deleted records');

  // 恢复：回到正常列表，回收站清空该条
  const restored = await (await authFetch(`/api/problems/${rb.id}/restore`, { method: 'POST' })).json();
  assert(restored && String(restored.id) === String(rb.id), 'restore returns restored record');
  assert((await (await authFetch('/api/problems?pageSize=100')).json()).rows.some((r) => String(r.id) === String(rb.id)), 'restored record back in normal list');
  assert(!(await (await authFetch('/api/problems?deleted=1&pageSize=100')).json()).rows.some((r) => String(r.id) === String(rb.id)), 'restored record no longer in recycle bin');

  // 彻底删除：真删 + 附件清理，回收站中也没有
  const fdR = new FormData();
  fdR.append('file', new Blob(['purge me'], { type: 'text/plain' }), 'purge.txt');
  const upR = await (await fetch(BASE + `/api/problems/${rb.id}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fdR })).json();
  const purgePath = path.join(tmpUploads, upR.storedName);
  assert(fs.existsSync(purgePath), 'attachment file lands on disk (purge test)');
  assert((await authFetch(`/api/problems/${rb.id}`, { method: 'DELETE' })).status === 200, 'soft delete before purge');
  await new Promise((r) => setTimeout(r, 150));
  assert(fs.existsSync(purgePath), 'soft delete keeps attachment file');
  assert((await authFetch(`/api/problems/${rb.id}/hard`, { method: 'DELETE' })).status === 200, 'hard delete -> 200');
  await new Promise((r) => setTimeout(r, 150));
  assert(!fs.existsSync(purgePath), 'hard delete removes attachment files from disk');
  assert((await authFetch(`/api/problems/${rb.id}`)).status === 404, 'purged record gone from normal detail');
  assert((await authFetch(`/api/problems/${rb.id}?deleted=1`)).status === 404, 'purged record gone from recycle bin too');
  const rAudit2 = await (await authFetch('/api/audit?action=RESTORE_ISSUE')).json();
  assert(rAudit2.total >= 1, 'RESTORE_ISSUE audited');
  const pAudit = await (await authFetch('/api/audit?action=PURGE_ISSUE')).json();
  assert(pAudit.total >= 1 && pAudit.rows.every((r) => r.action === 'PURGE_ISSUE'), 'PURGE_ISSUE audited');

  // ---- v1.16：聊天（AI 助手 + 同事会话）----
  const chatUnread0 = await (await authFetch('/api/chat/unread')).json();
  assert(typeof chatUnread0.total === 'number', 'chat unread endpoint returns total number');
  const aiConv = await (await authFetch('/api/chat/ai')).json();
  assert(aiConv && aiConv.type === 'ai' && aiConv.created_by === 'admin', 'AI 助手会话自动创建且归属当前用户');
  const aiSend = await (await authFetch(`/api/chat/conversations/${aiConv.id}/messages`, { method: 'POST', body: JSON.stringify({ body: '你好' }) })).json();
  assert(aiSend.user && aiSend.assistant && aiSend.assistant.sender === 'assistant', 'AI 会话发送后返回助手占位回复');
  const aiMsgs = await (await authFetch(`/api/chat/conversations/${aiConv.id}/messages`)).json();
  assert(aiMsgs.length >= 2 && aiMsgs.some((m) => m.sender === 'assistant'), 'AI 会话消息含助手回复');
  const newConvRes = await (await authFetch('/api/chat/conversations', { method: 'POST', body: JSON.stringify({ type: 'user', members: ['reporter1'] }) })).json();
  assert(newConvRes && newConvRes.type === 'user' && newConvRes.members.includes('admin') && newConvRes.members.includes('reporter1'), '新建同事会话：创建人自动加入、成员含对方');
  const ucSend = await (await authFetch(`/api/chat/conversations/${newConvRes.id}/messages`, { method: 'POST', body: JSON.stringify({ body: '请查一下 HIS 故障' }) })).json();
  assert(ucSend && ucSend.user && ucSend.user.sender === 'admin', '同事会话成员可发言');
  // 非成员发言应被拒（v1.16 成员校验修复点）
  const outRes = await authFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: 'chatout', name: '局外人', password: 'out1234', role: 'reporter' }) });
  assert(outRes.status === 201, 'create outsider user for chat non-member test');
  const outLogin = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'chatout', password: 'out1234' }) })).json();
  const outSend = await tokenFetch(outLogin.token, `/api/chat/conversations/${newConvRes.id}/messages`, { method: 'POST', body: JSON.stringify({ body: '我是局外人' }) });
  assert(outSend.status === 403, '非会话成员发言被拒 403（v1.16 成员校验）');

  // ---- v1.17：聊天附件（上传 → 随消息发送 → 预览/下载 → 权限）----
  const attFd = new FormData();
  attFd.append('file', new Blob(['chat attachment body'], { type: 'text/plain' }), 'note.txt');
  const upAttRes = await fetch(BASE + `/api/chat/conversations/${aiConv.id}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: attFd });
  const upAtt = await upAttRes.json();
  assert(upAttRes.status === 201 && /^[a-f0-9]{24}(\.[A-Za-z0-9]{1,12})?$/.test(upAtt.storedName), '聊天附件上传返回合法 storedName');
  assert(upAtt.originalName === 'note.txt' && upAtt.size > 0, '聊天附件元数据完整');

  const imgFd = new FormData();
  imgFd.append('file', new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'pic.png');
  const upImg = await (await fetch(BASE + `/api/chat/conversations/${aiConv.id}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: imgFd })).json();
  assert(upImg.type === 'image/png', '聊天附件保留 mimetype（图片）');

  const attSend = await (await authFetch(`/api/chat/conversations/${aiConv.id}/messages`, { method: 'POST', body: JSON.stringify({ body: '', attachments: [upAtt, upImg] }) })).json();
  assert(attSend.user && attSend.user.attachments && attSend.user.attachments.length === 2, '仅带附件的消息可发送并落库');
  assert(attSend.assistant && attSend.assistant.sender === 'assistant', '带附件的 AI 会话仍返回助手回复');

  const afterMsgs = await (await authFetch(`/api/chat/conversations/${aiConv.id}/messages`)).json();
  assert(afterMsgs.some((m) => (m.attachments || []).length === 2), '消息列表回读含附件');

  const dlInline = await fetch(BASE + `/api/chat/attachments/${upAtt.storedName}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert(dlInline.status === 200 && (await dlInline.text()) === 'chat attachment body', '聊天附件可 inline 取回');
  assert((await fetch(BASE + `/api/chat/attachments/${upAtt.storedName}?download=1`, { headers: { Authorization: 'Bearer ' + TOKEN } })).status === 200, '聊天附件可下载');
  assert((await fetch(BASE + '/api/chat/attachments/badname', { headers: { Authorization: 'Bearer ' + TOKEN } })).status === 400, '非法附件名被拒 400');

  // 非会话成员上传附件 -> 403
  const outAttFd = new FormData();
  outAttFd.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
  const outUp = await fetch(BASE + `/api/chat/conversations/${newConvRes.id}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + outLogin.token }, body: outAttFd });
  assert(outUp.status === 403, '非会话成员上传附件被拒 403');

  // ---- 回归 v1.18.5：中文文件名不得乱码 ----
  // 根因：multipart 的 Content-Disposition filename 被 busboy 按 latin1 解码（defParamCharset 默认值），
  // 而浏览器发的是 UTF-8 字节 → 「会议纪要.pdf」在服务端变成「ä¼šè®®çºªè¦.pdf」。
  const CN_NAME = '会议纪要2026.pdf';
  const cnRec = await (await mk({ title: '中文名附件测试', department: '信息科', reporter: '张三', type: '故障', severity: '低', description: 'x' })).json();
  const cnFd = new FormData();
  // undici 的 FormData 与 Chromium 行为一致：filename 以 UTF-8 字节直接写进 header
  cnFd.append('file', new Blob(['cn attachment body'], { type: 'application/pdf' }), CN_NAME);
  const cnUpRes = await fetch(BASE + `/api/problems/${cnRec.id}/attachments`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + RTOKEN }, body: cnFd,
  });
  const cnAtt = await cnUpRes.json();
  assert(cnUpRes.status === 201, '中文名附件上传成功 201');
  assert(cnAtt.originalName === CN_NAME, `中文文件名不乱码（实际得到「${cnAtt.originalName}」）`);
  assert(/^[a-f0-9]{24}\.pdf$/.test(cnAtt.storedName), `落盘名 = 24 位随机 hex + 正确扩展名（实际 ${cnAtt.storedName}）`);

  const cnGet = await (await tokenFetch(RTOKEN, `/api/problems/${cnRec.id}`)).json();
  assert((cnGet.attachments || []).some((a) => a.originalName === CN_NAME), '回读记录中的中文文件名正确');
  assert(!JSON.stringify(cnGet).includes('\u00e4\u00bc\u009a'), '记录中不含乱码片段（ä¼š…）');

  const cnDl = await fetch(BASE + `/api/problems/${cnRec.id}/attachments/${cnAtt.id}`, { headers: { Authorization: 'Bearer ' + RTOKEN } });
  assert(cnDl.status === 200 && (await cnDl.text()) === 'cn attachment body', '中文名附件内容可取回');
  assert((cnDl.headers.get('content-disposition') || '').includes(encodeURIComponent(CN_NAME)),
    `下载响应头 Content-Disposition 使用 UTF-8 编码的中文文件名（实际 ${cnDl.headers.get('content-disposition')}）`);

  // 老客户端/存量数据兜底：把「latin1 误解码后的乱码串」本身当文件名发上来，服务端也应还原
  const mojiName = Buffer.from(CN_NAME, 'utf8').toString('latin1');
  const mojiFd = new FormData();
  mojiFd.append('file', new Blob(['legacy'], { type: 'application/pdf' }), mojiName);
  const mojiUp = await (await fetch(BASE + `/api/problems/${cnRec.id}/attachments`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: mojiFd,
  })).json();
  assert(mojiUp.originalName === CN_NAME, `乱码文件名在落库前被还原（实际得到「${mojiUp.originalName}」）`);
  assert(/^[a-f0-9]{24}\.pdf$/.test(mojiUp.storedName), '还原后的扩展名同样正确');

  // 聊天附件同源上传中间件，中文名同样不能乱码
  const cnChatFd = new FormData();
  cnChatFd.append('file', new Blob(['chat cn'], { type: 'image/png' }), '门诊叫号系统异常截图.png');
  const cnChat = await (await fetch(BASE + `/api/chat/conversations/${aiConv.id}/attachments`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: cnChatFd,
  })).json();
  assert(cnChat.originalName === '门诊叫号系统异常截图.png', `聊天附件中文名不乱码（实际得到「${cnChat.originalName}」）`);
  assert(/^[a-f0-9]{24}\.png$/.test(cnChat.storedName), '聊天附件落盘扩展名正确');
  const cnChatSend = await (await authFetch(`/api/chat/conversations/${aiConv.id}/messages`, {
    method: 'POST', body: JSON.stringify({ body: '', attachments: [cnChat] }),
  })).json();
  assert((cnChatSend.user.attachments || [])[0].originalName === '门诊叫号系统异常截图.png', '随消息发送的附件名正确');
  const cnChatMsgs = await (await authFetch(`/api/chat/conversations/${aiConv.id}/messages`)).json();
  assert(cnChatMsgs.some((m) => (m.attachments || []).some((a) => a.originalName === '门诊叫号系统异常截图.png')),
    '聊天消息回读后中文附件名仍然正确');

  // 操作日志里的文件名同样应是可读中文（排查问题时能对上号）
  const cnAudit = await (await authFetch('/api/audit?action=UPLOAD_ATTACHMENT&pageSize=100')).json();
  assert(cnAudit.rows.some((r) => r.detail === CN_NAME), '操作日志明细记录的是正确中文文件名');
  assert(!cnAudit.rows.some((r) => typeof r.detail === 'string' && r.detail.includes('\u00e4\u00bc\u009a')),
    '操作日志中不含乱码文件名片段');

  // 清理：删掉这条测试问题（含附件文件），不给后续断言留噪音
  await authFetch(`/api/problems/${cnRec.id}`, { method: 'DELETE' });
  await authFetch(`/api/problems/${cnRec.id}/hard`, { method: 'DELETE' });
  assert((await authFetch(`/api/problems/${cnRec.id}`)).status === 404, '中文名附件测试记录已清理');

  // ================= v1.18：多机构（单实例 + 单库 + 行级 org_id 隔离） =================
  const orgList0 = await (await authFetch('/api/orgs')).json();
  assert(Array.isArray(orgList0.orgs) && orgList0.orgs.length === 1 && orgList0.orgs[0].id === 1,
    '启动引导后默认机构唯一存在（id=1）');

  const org2Res = await authFetch('/api/orgs', { method: 'POST', body: JSON.stringify({ name: '海盐县中医院' }) });
  const org2 = await org2Res.json();
  assert(org2Res.status === 201 && org2.id === 2 && org2.name === '海盐县中医院', '平台管理员可新建机构（id=2）');
  assert((await authFetch('/api/orgs', { method: 'POST', body: JSON.stringify({ name: '   ' }) })).status === 400, '空机构名被拒 400');

  // 切换到机构 2（平台管理员在无成员关系的机构按全局角色 admin 生效）
  const swRes = await authFetch('/api/auth/switch-org', { method: 'POST', body: JSON.stringify({ orgId: org2.id }) });
  const sw = await swRes.json();
  assert(swRes.status === 200 && !!sw.token && sw.org.id === 2 && sw.user.role === 'admin', '切换到机构 2 成功并重新签发 token');
  const T2 = sw.token;
  const me2 = await (await tokenFetch(T2, '/api/auth/me')).json();
  assert(me2.org && me2.org.id === 2 && me2.orgs.length === 2, 'GET /me 返回当前机构 + 可访问机构列表');

  // —— 问题数据按机构隔离 ——
  const i2res = await tokenFetch(T2, '/api/problems', {
    method: 'POST',
    body: JSON.stringify({ title: '机构2专属问题', department: '内科', reporter: '机构2用户', type: '故障', severity: '中', description: '隔离验证' }),
  });
  const i2 = await i2res.json();
  assert(i2res.status === 201 && i2.org_id === 2, '机构 2 内登记的问题归属 org_id=2');

  const list2 = await (await tokenFetch(T2, '/api/problems')).json();
  assert(list2.total === 1 && list2.rows.length === 1 && list2.rows[0].id === i2.id, '机构 2 只看到自己那 1 条问题');

  const list1 = await (await authFetch('/api/problems')).json();
  assert(list1.total > 1 && !list1.rows.some((r) => r.id === i2.id), '机构 1 列表看不到机构 2 的问题（跨机构隔离）');

  assert((await authFetch('/api/problems/' + i2.id)).status === 404, '跨机构读取详情 -> 404（不泄漏存在性）');
  assert((await authFetch('/api/problems/' + i2.id, { method: 'PUT', body: JSON.stringify({ title: '越权改' }) })).status === 404, '跨机构编辑 -> 404');
  assert((await authFetch('/api/problems/' + i2.id, { method: 'DELETE' })).status === 404, '跨机构删除 -> 404');

  const stat1 = await (await authFetch('/api/problems/stats')).json();
  assert(stat1.total === list1.total, '机构 1 统计口径与列表一致（不含机构 2 数据）');
  const trend1 = await (await authFetch('/api/problems/trend')).json();
  assert(trend1.byDepartment.reduce((s, d) => s + d.count, 0) === list1.total, '机构 1 趋势聚合总数 = 本机构问题总数（口径隔离）');
  const trend2 = await (await tokenFetch(T2, '/api/problems/trend')).json();
  assert(trend2.byDepartment.reduce((s, d) => s + d.count, 0) === 1, '机构 2 趋势聚合仅含本机构那 1 条');

  // —— 机构级设置隔离 ——
  const cfg2 = await (await tokenFetch(T2, '/api/config')).json();
  const cfg1 = await (await authFetch('/api/config')).json();
  assert(cfg2.appName === '海盐县中医院', '机构 2 的系统名称 = 该机构名（新建时自动初始化）');
  assert(cfg1.appName !== '海盐县中医院', '机构 1 系统名称不受机构 2 影响（机构级设置隔离）');
  // —— 回归 v1.18.6：侧栏品牌名的数据源必须「随当前机构往返」——
  // /api/config 由 token 的 org 声明决定返回哪个机构的设置；切回来必须恢复原值，
  // 否则「左侧名称跟着机构变」会出现单程生效（去得回不来）的错觉。
  const swBackCfg = await (await tokenFetch(T2, '/api/auth/switch-org', { method: 'POST', body: JSON.stringify({ orgId: 1 }) })).json();
  assert(!!swBackCfg.token, '按 orgId=1 切回成功并重签 token');
  const cfgBack = await (await tokenFetch(swBackCfg.token, '/api/config')).json();
  assert(cfgBack.appName === cfg1.appName, `切回机构 1 后系统名称恢复原值（${cfgBack.appName}）`);
  assert(cfgBack.appName !== cfg2.appName, '往返后两个机构的系统名称不会互相污染');
  // 未携带 token 时 /api/config 回落默认机构（登录页品牌名用）
  const cfgAnon = await (await fetch(BASE + '/api/config')).json();
  assert(!!cfgAnon.appName, '匿名 /api/config 仍返回默认机构的系统名称');

  // —— 审计日志按机构隔离 ——
  const aud2 = await (await tokenFetch(T2, '/api/audit')).json();
  assert(aud2.rows.length > 0 && aud2.rows.every((r) => Number(r.org_id) === 2), '机构 2 的审计日志仅含本机构记录');
  const aud1 = await (await authFetch('/api/audit')).json();
  assert(aud1.rows.length > 0 && aud1.rows.every((r) => Number(r.org_id) === 1), '机构 1 的审计日志仅含本机构记录');

  // —— 通知按机构隔离（广播只发给本机构成员）——
  const usersForOrg = await (await authFetch('/api/users')).json();
  const adminRow = usersForOrg.find((u) => u.username === 'admin');
  assert(!!adminRow && adminRow.id, '机构 1 用户列表可读');
  assert((await authFetch('/api/orgs/' + org2.id + '/members', { method: 'POST', body: JSON.stringify({ userId: adminRow.id, role: 'admin' }) })).status === 200,
    '平台管理员可把用户加入机构 2');
  const members2 = await (await authFetch('/api/orgs/' + org2.id + '/members')).json();
  assert(members2.members.length === 1 && members2.members[0].username === 'admin', '机构 2 成员列表正确');
  // 成员接口同时返回「该机构角色表」与「可加入候选」——机构管理页据此渲染角色下拉与候选选择
  assert(Array.isArray(members2.roles) && members2.roles.some((r) => r.key === 'admin'),
    '成员接口返回该机构角色表（供角色下拉）');
  assert(Array.isArray(members2.candidates) && !members2.candidates.some((c) => String(c.id) === String(adminRow.id)),
    '候选用户已排除「已是本机构成员」的账号');

  const unread1Before = (await (await authFetch('/api/notifications/unread-count')).json()).unread;
  const bc2 = await (await tokenFetch(T2, '/api/notifications/broadcast', { method: 'POST', body: JSON.stringify({ title: '机构2广播', body: '仅机构2可见' }) })).json();
  assert(bc2.sent === 1, '机构 2 全员广播只发给机构 2 的 1 名成员');
  const unread1After = (await (await authFetch('/api/notifications/unread-count')).json()).unread;
  assert(unread1After === unread1Before, '机构 2 的广播不影响机构 1 的未读数（跨机构隔离）');
  assert((await (await tokenFetch(T2, '/api/notifications/unread-count')).json()).unread === 1, '机构 2 视角看到 1 条未读');
  assert((await (await tokenFetch(T2, '/api/notifications?unread=1')).json()).rows.length === 1, '机构 2 通知列表只含本机构通知');

  // —— 聊天按机构隔离 ——
  const ai2 = await (await tokenFetch(T2, '/api/chat/ai')).json();
  assert(ai2.org_id === 2, '机构 2 的 AI 会话归属 org_id=2');
  const conv2 = await (await tokenFetch(T2, '/api/chat/conversations')).json();
  const conv1 = await (await authFetch('/api/chat/conversations')).json();
  assert(conv2.some((c) => c.id === ai2.id) && !conv1.some((c) => c.id === ai2.id), '机构 1 会话列表看不到机构 2 的会话');
  assert((await tokenFetch(TOKEN, `/api/chat/conversations/${ai2.id}/messages`)).status === 404, '跨机构按 id 读取会话 -> 404');
  assert((await tokenFetch(T2, '/api/chat/conversations', { method: 'POST', body: JSON.stringify({ type: 'user', members: ['nobody'] }) })).status === 400,
    '把非本机构用户拉入会话被拒 400');

  // —— 值班表按机构隔离 ——
  const sch2 = await tokenFetch(T2, '/api/schedules', { method: 'POST', body: JSON.stringify({ date: '2030-01-07', handlerName: '机构2值班' }) });
  assert(sch2.status === 201, '机构 2 内可正常排班');
  const sch2Rows = await (await tokenFetch(T2, '/api/schedules?from=2030-01-01&to=2030-01-31')).json();
  const sch1Rows = await (await authFetch('/api/schedules?from=2030-01-01&to=2030-01-31')).json();
  assert(sch2Rows.length === 1 && sch1Rows.length === 0, '排班按机构隔离（机构 1 看不到机构 2 的排班）');

  // —— 非平台管理员：看不到机构管理，也不能越机构切换 ——
  assert((await authFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: 'plain1', name: '普通用户', password: 'plain123', role: 'reporter' }) })).status === 201,
    '创建普通用户 plain1');
  const plainLogin = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'plain1', password: 'plain123' }) })).json();
  assert(plainLogin.user.platformAdmin === false && plainLogin.orgs.length === 1 && plainLogin.orgs[0].id === 1,
    '普通用户登录只返回已归属机构、且非平台管理员');
  assert((await tokenFetch(plainLogin.token, '/api/orgs')).status === 403, '非平台管理员访问机构管理 -> 403');
  assert((await tokenFetch(plainLogin.token, '/api/auth/switch-org', { method: 'POST', body: JSON.stringify({ orgId: org2.id }) })).status === 403,
    '非成员切换到他机构 -> 403');
  assert((await tokenFetch(plainLogin.token, '/api/problems/' + i2.id)).status === 404, '普通用户跨机构读取 -> 404');
  assert((await tokenFetch(plainLogin.token, '/api/users/' + adminRow.id + '/platform-admin', { method: 'PUT', body: JSON.stringify({ platformAdmin: true }) })).status === 403,
    '非平台管理员不能指派平台管理员 -> 403');

  // —— 成员指派闭环（机构管理页「成员管理」走的正是这几个接口）——
  const plainRow = (await (await authFetch('/api/users')).json()).find((u) => u.username === 'plain1');
  assert(!!plainRow && plainRow.id, '机构 1 用户列表含 plain1');
  assert((await authFetch('/api/orgs/' + org2.id + '/members', { method: 'POST', body: JSON.stringify({ userId: plainRow.id, role: 'nope' }) })).status === 400,
    '指派不存在的角色 -> 400');
  assert((await authFetch('/api/orgs/' + org2.id + '/members', { method: 'POST', body: JSON.stringify({ userId: plainRow.id, role: 'reporter' }) })).status === 200,
    '把 plain1 加入机构 2 成功');
  const memAfterAdd = await (await authFetch('/api/orgs/' + org2.id + '/members')).json();
  assert(memAfterAdd.members.some((m) => m.username === 'plain1' && m.role === 'reporter'),
    '机构 2 成员列表含 plain1 且角色为机构内角色');
  assert(!memAfterAdd.candidates.some((c) => String(c.id) === String(plainRow.id)),
    '加入后该账号从「可加入候选」中移除');
  assert((await authFetch('/api/orgs/' + org2.id + '/members', { method: 'POST', body: JSON.stringify({ userId: plainRow.id, role: 'admin' }) })).status === 200,
    '重复 POST 成员即「改机构内角色」（upsert）');
  const memRoleChanged = await (await authFetch('/api/orgs/' + org2.id + '/members')).json();
  assert(memRoleChanged.members.find((m) => m.username === 'plain1').role === 'admin',
    '机构内角色已由 reporter 改为 admin');
  assert((await authFetch('/api/orgs/' + org2.id + '/members/' + plainRow.id, { method: 'DELETE' })).status === 200,
    '把 plain1 移出机构 2 成功');
  const memAfterKick = await (await authFetch('/api/orgs/' + org2.id + '/members')).json();
  assert(memAfterKick.candidates.some((c) => String(c.id) === String(plainRow.id)),
    '移出后该账号回到「可加入候选」');
  assert((await authFetch('/api/orgs/' + org2.id + '/members/' + adminRow.id, { method: 'DELETE' })).status === 400,
    '不能移出机构的最后一个成员 -> 400');

  // —— 平台管理员指派闭环 ——
  assert((await authFetch('/api/users/' + plainRow.id + '/platform-admin', { method: 'PUT', body: JSON.stringify({ platformAdmin: true }) })).status === 200,
    '平台管理员可授予他人平台管理员');
  assert((await (await authFetch('/api/users')).json()).find((u) => u.username === 'plain1').platformAdmin === true,
    '授予后该用户在用户列表中标记为平台管理员');
  assert((await authFetch('/api/users/' + plainRow.id + '/platform-admin', { method: 'PUT', body: JSON.stringify({ platformAdmin: false }) })).status === 200,
    '平台管理员可取消他人平台管理员');
  assert((await (await authFetch('/api/users')).json()).find((u) => u.username === 'plain1').platformAdmin === false,
    '取消后标记已清除');

  // —— 回归 v1.18.1：平台管理员身份「以库为准」，不能只信 token 声明 ——
  // 真实线上问题：升级前签发的旧 token 不含 platform 声明，前端 /auth/me 却现查库报「是平台管理员」，
  // 于是界面显示标记与「机构管理」菜单、点保存却 403「仅平台管理员可执行此操作」。
  const legacyToken = jwtSign(
    { sub: adminRow.id, username: 'admin', name: '系统管理员', role: 'admin' },   // 故意不带 org / platform
    LEGACY_SECRET,
  );
  const legacyMe = await (await tokenFetch(legacyToken, '/api/auth/me')).json();
  assert(legacyMe.user && legacyMe.user.platformAdmin === true, '旧 token 的 /me 报告真实的平台管理员身份');
  assert((await tokenFetch(legacyToken, '/api/orgs')).status === 200,
    '旧 token（无 platform 声明）仍可访问机构管理 -> 200（不再误拒真实平台管理员）');
  const legacyCreate = await tokenFetch(legacyToken, '/api/orgs', { method: 'POST', body: JSON.stringify({ name: '旧token新建机构' }) });
  assert(legacyCreate.status === 201, '旧 token 可新建机构 -> 201');
  const legacyOrg = await legacyCreate.json();
  assert((await authFetch('/api/orgs/' + legacyOrg.id, { method: 'DELETE' })).status === 200, '（清理）删除旧 token 建出的机构');

  // 反向：普通用户即便伪造 platform 声明也必须被拒（否则等于自封平台管理员）
  const fakeToken = jwtSign(
    { sub: plainRow.id, username: 'plain1', name: '普通用户', role: 'reporter', org: 1, platform: true },
    LEGACY_SECRET,
  );
  assert((await tokenFetch(fakeToken, '/api/orgs')).status === 403,
    '普通用户 token 自称 platform=true 仍被拒 -> 403（以库为准，杜绝自封）');

  // 撤销 / 授予必须立即生效，不必等 token 过期
  assert((await authFetch('/api/users/' + plainRow.id + '/platform-admin', { method: 'PUT', body: JSON.stringify({ platformAdmin: true }) })).status === 200,
    '授予 plain1 平台管理员（用于验证立即生效）');
  const promotedToken = jwtSign(
    { sub: plainRow.id, username: 'plain1', name: '普通用户', role: 'reporter', org: 1, platform: true },
    LEGACY_SECRET,
  );
  assert((await tokenFetch(promotedToken, '/api/orgs')).status === 200, '授予后该 token 立即可用 -> 200');
  assert((await authFetch('/api/users/' + plainRow.id + '/platform-admin', { method: 'PUT', body: JSON.stringify({ platformAdmin: false }) })).status === 200,
    '取消 plain1 平台管理员');
  assert((await tokenFetch(promotedToken, '/api/orgs')).status === 403,
    '取消后同一 token 立即失效 -> 403（无需等 token 过期，避免被撤销者继续跨机构操作）');

  // —— 回归 v1.18.3：平台管理员在「无成员关系的机构」必须按管理员生效 ——
  // 真实问题：平台管理员的全局角色（app_user.role）多为「登记员」，而角色解析在「无成员关系」时
  // 回落全局角色 —— 切到别家机构后 users / settings 菜单直接消失、接口全 403，
  // 出现「平台管理员在别的机构里什么都管不了」的自相矛盾。
  const paRes = await authFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: 'pa_reporter', name: '跨机构管理员', password: 'pa12345', role: 'reporter' }) });
  const paRow = await paRes.json();
  assert(paRes.status === 201 && !!paRow.id, '新建一个「全局角色 = 登记员」的账号');
  assert((await authFetch('/api/users/' + paRow.id + '/platform-admin', { method: 'PUT', body: JSON.stringify({ platformAdmin: true }) })).status === 200,
    '把它设为平台管理员');
  const paLogin = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pa_reporter', password: 'pa12345' }) })).json();
  assert(paLogin.user.platformAdmin === true, '该账号登录后确认为平台管理员');
  // v1.18.10：平台管理员在**全部机构**都按管理员生效 —— 包括「有成员关系的机构」。
  // v1.18.3 当时的口径是「成员关系优先」，但 v1.18 升级会把「全局角色」复制成默认机构的
  // **成员角色**，而平台管理员的全局角色往往是登记员 → 他在自己的医院里被降权
  // （真实用户截图：海盐县人民医院少了 审核通过 / 用户管理 / 系统设置 三个菜单）。
  // 这条限制也不是有效的安全边界 —— 平台管理员本就能在任意机构把自己改成管理员。
  assert((paLogin.orgs.find((o) => Number(o.id) === 1) || {}).role === 'admin',
    'v1.18.10：平台管理员在「有成员关系的机构 1」也按管理员生效（不再被成员角色降权）');
  assert((paLogin.orgs.find((o) => Number(o.id) === org2.id) || {}).role === 'admin',
    '平台管理员在「无成员关系的机构」有效角色 = 管理员（v1.18.3 修复，保持不变）');
  assert((await tokenFetch(paLogin.token, '/api/users')).status === 200,
    'v1.18.10：平台管理员在自己的医院里「用户管理」立即可用（修复前被成员角色降权 403）');
  // 写路径：给平台管理员「设」别的角色会被纠正，不留下永不生效的角色
  const paCoerce = await authFetch('/api/orgs/1/members', { method: 'POST', body: JSON.stringify({ userId: paRow.id, role: 'reporter' }) });
  const paCoerceBody = await paCoerce.json();
  assert(paCoerce.status === 200 && paCoerceBody.role === 'admin' && paCoerceBody.coerced === true,
    `把平台管理员的机构内角色设为 reporter → 落库纠正为 admin 并回报 coerced（实测 ${paCoerce.status}、role=${paCoerceBody.role}、coerced=${paCoerceBody.coerced}）`);
  const paDeny = await authFetch('/api/users/' + paRow.id + '/role', { method: 'PUT', body: JSON.stringify({ role: 'reporter' }) });
  assert(paDeny.status === 400 && /平台管理员/.test((await paDeny.json()).error || ''),
    '改平台管理员的机构内角色被明确拒绝 400（而非静默存一个不生效的值）');
  const paSwRes = await tokenFetch(paLogin.token, '/api/auth/switch-org', { method: 'POST', body: JSON.stringify({ orgId: org2.id }) });
  assert(paSwRes.status === 200, '平台管理员可切到没有成员关系的机构');
  const paT2 = (await paSwRes.json()).token;
  assert((await tokenFetch(paT2, '/api/users')).status === 200,
    '切过去后「用户管理」可用 -> 200（修复前为 403）');
  assert((await tokenFetch(paT2, '/api/settings', { method: 'PUT', body: JSON.stringify({ appName: '海盐县中医院' }) })).status === 200,
    '切过去后「系统设置」可用 -> 200（修复前为 403）');

  // —— 回归 v1.18.3：新建机构时创建者自动成为该机构成员 ——
  // 否则新机构以「0 成员」开局：成员列表空白、广播无人接收、刚建好却无人可管，
  // 且与「不能移出该机构最后一个成员」的守卫自相矛盾。
  const org3Res = await authFetch('/api/orgs', { method: 'POST', body: JSON.stringify({ name: '创建者入机构验证' }) });
  const org3 = await org3Res.json();
  assert(org3Res.status === 201 && !!org3.id, '新建用于验证的机构');
  const m3 = await (await authFetch('/api/orgs/' + org3.id + '/members')).json();
  assert(m3.members.length === 1 && m3.members[0].username === 'admin' && m3.members[0].role === 'admin',
    '创建者自动成为新机构成员（管理员角色），不再以 0 成员开局');
  assert(!m3.candidates.some((c) => c.username === 'admin'), '创建者不再出现在该机构的「可加入候选」里');
  assert((await authFetch('/api/orgs/' + org3.id, { method: 'DELETE' })).status === 200, '（清理）删除该验证机构');

  // —— 回归 v1.18.3：修改「机构内角色」不得回写全局角色 ——
  // app_user.role（全局角色）是「无成员关系机构」的角色回落来源，回写 = 把本机构改动泄漏到别的机构。
  const globalRoleBefore = JSON.parse(fs.readFileSync(tmpUsers, 'utf8')).find((u) => u.username === 'pa_reporter').role;
  assert((await authFetch('/api/users/' + paRow.id + '/role', { method: 'PUT', body: JSON.stringify({ role: 'admin' }) })).status === 200,
    '在机构 1 把 pa_reporter 的机构内角色改为 admin');
  const globalRoleAfter = JSON.parse(fs.readFileSync(tmpUsers, 'utf8')).find((u) => u.username === 'pa_reporter').role;
  assert(globalRoleAfter === globalRoleBefore,
    '全局角色未被改写（仍为 reporter）：机构内角色改动不泄漏到其它机构');
  assert((await (await authFetch('/api/users')).json()).find((u) => u.username === 'pa_reporter').role === 'admin',
    '机构 1 花名册里该用户角色已变为 admin（机构内角色确实生效）');

  // —— 回归 v1.18.3：跨机构按 id 改角色 -> 404（不泄漏存在性，也不静默把外部账号拉进本机构）——
  const o2uRes = await tokenFetch(T2, '/api/users', { method: 'POST', body: JSON.stringify({ username: 'org2only', name: '仅机构2用户', password: 'o2u12345', role: 'reporter' }) });
  const o2u = await o2uRes.json();
  assert(o2uRes.status === 201, '在机构 2 内新建用户（只属于机构 2）');
  assert((await authFetch('/api/users/' + o2u.id + '/role', { method: 'PUT', body: JSON.stringify({ role: 'admin' }) })).status === 404,
    '在机构 1 按 id 修改「仅属于机构 2」的用户角色 -> 404');
  assert(!(await (await authFetch('/api/users')).json()).some((u) => u.username === 'org2only'),
    '该账号未因此被静默拉进机构 1 花名册');

  // —— 回归 v1.18.7：账号级操作（重置密码 / 停用启用）的机构边界 ——
  // 真实越权面：这两个接口此前只检查 user.manage，而「密码」与「启停状态」都是账号级、全局唯一的
  // （与该用户归属哪些机构无关），于是甲机构的管理员可以按 id 重置/停用一个「只属于乙机构」的账号
  // —— 跨机构接管他人账号。修复后只允许：① 调用者是平台管理员；② 目标账号属于本机构且不属于任何其它机构。
  const o2aRes = await tokenFetch(T2, '/api/users', { method: 'POST', body: JSON.stringify({ username: 'o2admin', name: '中医院管理员', password: 'o2admin123', role: 'admin' }) });
  const o2a = await o2aRes.json();
  assert(o2aRes.status === 201 && !!o2a.id, '在机构 2 内新建一个「机构管理员」（非平台管理员）');
  const o2aLogin = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'o2admin', password: 'o2admin123' }) })).json();
  const TA = o2aLogin.token;
  assert(o2aLogin.user.platformAdmin === false && o2aLogin.org.id === org2.id && o2aLogin.user.role === 'admin',
    '该机构管理员只属于机构 2，且在本机构内具备用户管理权限');
  assert((await tokenFetch(TA, '/api/users')).status === 200, '机构 2 管理员可读本机构花名册 -> 200');
  assert(!(await (await tokenFetch(TA, '/api/users')).json()).some((u) => u.username === 'plain1'),
    '花名册不含机构 1 的账号（用户列表按机构隔离）');

  const plain1Row = (await (await authFetch('/api/users')).json()).find((u) => u.username === 'plain1');
  assert(!!plain1Row && plain1Row.id, '取到「只属于机构 1」的账号 plain1');
  assert((await tokenFetch(TA, '/api/users/' + plain1Row.id + '/password', { method: 'PUT', body: JSON.stringify({ password: 'hacked123' }) })).status === 404,
    '机构 2 管理员重置「只属于机构 1」账号的密码 -> 404（修复前为 200）');
  assert((await tokenFetch(TA, '/api/users/' + plain1Row.id + '/status', { method: 'PUT', body: JSON.stringify({ active: false }) })).status === 404,
    '机构 2 管理员停用「只属于机构 1」账号 -> 404（修复前为 200）');
  assert(JSON.parse(fs.readFileSync(tmpUsers, 'utf8')).find((u) => u.username === 'plain1').active !== false,
    '越权停用无副作用：该账号仍为启用中');

  // 反向：本机构专属账号仍可正常管理（不能矫枉过正）
  assert((await tokenFetch(TA, '/api/users/' + o2u.id + '/password', { method: 'PUT', body: JSON.stringify({ password: 'o2u_new123' }) })).status === 200,
    '机构 2 管理员可重置「本机构专属账号」的密码 -> 200');
  assert((await tokenFetch(TA, '/api/users/' + o2u.id + '/status', { method: 'PUT', body: JSON.stringify({ active: false }) })).status === 200,
    '机构 2 管理员可停用「本机构专属账号」-> 200');
  assert((await tokenFetch(TA, '/api/users/' + o2u.id + '/status', { method: 'PUT', body: JSON.stringify({ active: true }) })).status === 200,
    '（还原）重新启用该账号');

  // 平台管理员不受机构限制：跨机构管理本就是其职责，无需先切到目标机构
  assert((await authFetch('/api/users/' + o2u.id + '/password', { method: 'PUT', body: JSON.stringify({ password: 'o2u_back123' }) })).status === 200,
    '平台管理员可跨机构重置账号密码 -> 200');

  // 「共有账号」（同属两个机构）不属于任何单一机构：其密码/启停由平台管理员统管
  assert((await authFetch('/api/orgs/' + org2.id + '/members', { method: 'POST', body: JSON.stringify({ userId: plain1Row.id, role: 'reporter' }) })).status === 200,
    '（准备）平台管理员把 plain1 也加入机构 2，成为两机构共有账号');
  assert((await tokenFetch(TA, '/api/users/' + plain1Row.id + '/password', { method: 'PUT', body: JSON.stringify({ password: 'shared123' }) })).status === 404,
    '共有账号的密码不可由任一机构单独重置 -> 404（全局密码由平台管理员统管）');
  assert((await tokenFetch(TA, '/api/users/' + plain1Row.id + '/role', { method: 'PUT', body: JSON.stringify({ role: 'admin' }) })).status === 200,
    '但共有账号的「机构内角色」仍可由本机构自行调整 -> 200（机构内角色本就按机构隔离）');
  assert((await authFetch('/api/users/' + plain1Row.id + '/password', { method: 'PUT', body: JSON.stringify({ password: 'plain123' }) })).status === 200,
    '平台管理员可重置共有账号密码（并还原为原值）');
  assert((await authFetch('/api/orgs/' + org2.id + '/members/' + plain1Row.id, { method: 'DELETE' })).status === 200,
    '（还原）把 plain1 移出机构 2');
  assert((await tokenFetch(TA, '/api/orgs/' + org2.id + '/members')).status === 403,
    '机构管理员仍不能访问「成员管理」（机构管理归平台管理员）-> 403');
  assert((await tokenFetch(TA, '/api/users', { method: 'POST', body: JSON.stringify({ username: 'plain1', name: '同名新建', password: 'z123456', role: 'reporter' }) })).status === 409,
    '机构管理员想用「已占用的用户名」新建 -> 409（同名账号需由平台管理员加入本机构）');

  // —— 机构守卫 ——
  assert((await authFetch('/api/orgs/' + org2.id, { method: 'PUT', body: JSON.stringify({ active: false }) })).status === 200, '停用非唯一机构成功');
  assert((await authFetch('/api/orgs/1', { method: 'PUT', body: JSON.stringify({ active: false }) })).status === 400, '停用最后一个启用机构 -> 400');
  assert((await authFetch('/api/orgs/1', { method: 'DELETE' })).status === 400, '默认机构不可删除 -> 400');
  assert((await authFetch('/api/orgs/' + org2.id, { method: 'DELETE' })).status === 200, '删除非默认机构成功');
  const orgListEnd = await (await authFetch('/api/orgs')).json();
  assert(orgListEnd.orgs.length === 1 && orgListEnd.orgs[0].id === 1, '删除后仅剩默认机构');

  console.log(`\nRESULT: passed=${passed} failed=${failed}`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST ERROR', e);
  cleanup();
  process.exit(1);
});
