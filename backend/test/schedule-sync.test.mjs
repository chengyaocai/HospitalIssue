// v1.18.18 端到端：**排班跨机构同步 —— 带来源标记的镜像同步**（push 推给其他机构 / pull 从其他机构拉取）。
//
// 钉住的规则（与后端 routes/schedules.js 的 POST /api/schedules/sync 一一对应）：
//   1. 权限链：schedule.manage（requirePermission）之后还要 isPlatformAdmin（以库为准）；
//      非「排班管理」用户先被 requirePermission 拦下（403 文案不同）。
//   2. 镜像语义（v1.18.18，把目标时段与源对齐）：
//      ① 新增：源有、目标没有「同日同人」键 → 创建（打 synced=1 来源标记，登记人=操作者）；
//      ② 更新：同键条目内容（账号/姓名/备注）不一致 → 用源内容更新目标（不分 synced 标记，
//         手工条目也参与对齐；但对齐不改变其 synced 标记 —— 手工条目永不被镜像删除）；
//      ③ 不变：同键且内容一致 → unchanged；
//      ④ 移除（保守）：目标中 synced=1（上次同步产生）且源里已无该键的条目 → 删除；
//         手工 / 复制周条目（synced=0）永不被移除、键不匹配时完全不动。
//      重复同步幂等（全为 unchanged）；跨来源同日同人只落一条。
//   3. 数据归属：同步出来的条目 org_id 落在目标机构、createdBy 为操作者、带 synced 标记；
//      GET /api/schedules 依旧按机构隔离（A 看不到 B 的）。
//   4. 参数校验：from/to 必填且 isDateStr、from<=to、direction 合法、orgIds 非空且 ≤20、
//      机构须存在且未停用、orgIds 只含当前机构 → totalCopied=0（不算错误）。
//   5. 审计：出现 SYNC_SCHEDULE 动作，详情含 copied/updated/removed/unchanged 四元组。
//
// 运行：cd backend && node test/schedule-sync.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3620 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `schedsync-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `schedsync-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'schedule-sync-test-secret',
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
  try { body = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, body };
};
const login = async (username, password) => {
  const r = await J(`${BASE}/api/auth/login`, null, { method: 'POST', body: JSON.stringify({ username, password }) });
  return r.body && r.body.token ? r.body : null;
};
const switchOrg = async (token, orgId) => {
  const r = await J(`${BASE}/api/auth/switch-org`, token, { method: 'POST', body: JSON.stringify({ orgId }) });
  return r.status === 200 && r.body && r.body.token ? r.body.token : null;
};
const listSchedules = (token, from, to) =>
  J(`${BASE}/api/schedules?from=${from}&to=${to}`, token).then((r) => (r.body || []));
const createSchedule = (token, data) =>
  J(`${BASE}/api/schedules`, token, { method: 'POST', body: JSON.stringify(data) });
const sync = (token, data) =>
  J(`${BASE}/api/schedules/sync`, token, { method: 'POST', body: JSON.stringify(data) });

// 固定三周（周一 2026-03-02 起），互不重叠
const W1 = { from: '2026-03-02', to: '2026-03-08' };
const W2 = { from: '2026-03-09', to: '2026-03-15' };
const W3 = { from: '2026-03-16', to: '2026-03-22' };

async function main() {
  await waitReady();

  // ===== 0. 平台管理员登录 + 建机构 =====
  const adminLogin = await login('admin', 'admin123');
  assert(!!adminLogin && adminLogin.user.platformAdmin === true, '平台管理员登录成功');
  const mkB = await J(`${BASE}/api/orgs`, adminLogin.token, { method: 'POST', body: JSON.stringify({ code: 'b', name: 'B医院' }) });
  const mkC = await J(`${BASE}/api/orgs`, adminLogin.token, { method: 'POST', body: JSON.stringify({ code: 'c', name: 'C医院' }) });
  const mkD = await J(`${BASE}/api/orgs`, adminLogin.token, { method: 'POST', body: JSON.stringify({ code: 'd', name: 'D医院' }) });
  assert(mkB.status === 201 && mkC.status === 201 && mkD.status === 201, `新建机构 B/C/D（${mkB.status}/${mkC.status}/${mkD.status}）`);
  const orgA = 1; // 默认机构
  const orgB = mkB.body.id;
  const orgC = mkC.body.id;
  const orgD = mkD.body.id;
  // D 停用（供「机构不存在或已停用」用例）
  const dis = await J(`${BASE}/api/orgs/${orgD}`, adminLogin.token, { method: 'PUT', body: JSON.stringify({ active: false }) });
  assert(dis.status === 200 && dis.body.active === false, `停用机构 D（HTTP ${dis.status}）`);

  // 各机构 token（平台管理员切换）
  const tkA = adminLogin.token;
  const tkB = await switchOrg(tkA, orgB);
  const tkC = await switchOrg(tkA, orgC);
  assert(!!tkB && !!tkC, '平台管理员可切换到 B / C 机构');

  // ===== 1. push：当前机构（A）推送到 B、C 两个机构 =====
  const c1 = await createSchedule(tkA, { date: '2026-03-02', handlerName: '张三' });
  const c2 = await createSchedule(tkA, { date: '2026-03-03', handlerName: '李四', note: '夜班' });
  assert(c1.status === 201 && c2.status === 201, `A 机构（默认）本周排好 2 条班（${c1.status}/${c2.status}）`);

  const p1 = await sync(tkA, { direction: 'push', orgIds: [orgB, orgC], ...W1 });
  assert(p1.status === 200, `push 到 2 个机构返回 200（实测 ${p1.status}：${p1.body && p1.body.error}）`);
  assert(p1.body && p1.body.totalCopied === 4 && Array.isArray(p1.body.results) && p1.body.results.length === 2,
    `push 结果 totalCopied=4（2 条 × 2 机构）、results 两条（实测 ${JSON.stringify(p1.body)}）`);
  assert(p1.body.results.every((r) => r.copied === 2 && r.updated === 0 && r.removed === 0 && r.unchanged === 0),
    '每个目标机构 copied=2、updated=0、removed=0、unchanged=0');

  const bW1 = await listSchedules(tkB, W1.from, W1.to);
  assert(bW1.length === 2, `B 机构 GET /api/schedules 能看到该周 2 条（实测 ${bW1.length}）`);
  assert(bW1.every((e) => Number(e.org_id) === Number(orgB)), 'B 机构条目 org 归属正确（org_id=B）');
  assert(bW1.every((e) => e.createdBy === 'admin'), `B 机构条目 createdBy=操作者 admin（实测 ${bW1.map((e) => e.createdBy).join(',')}）`);
  assert(bW1.every((e) => e.synced === true || e.synced === 1), '同步产生的条目带 synced 来源标记（v1.18.18）');
  const names = bW1.map((e) => e.handlerName).sort().join(',');
  assert(names === '张三,李四', `条目内容一致（实测 ${names}）`);
  const cW1 = await listSchedules(tkC, W1.from, W1.to);
  assert(cW1.length === 2 && cW1.every((e) => Number(e.org_id) === Number(orgC)), 'C 机构同样收到 2 条且归属正确');

  // ===== 2. 重复 push：幂等（v1.18.18：内容一致 → 全部计入 unchanged，零变更）=====
  const p2 = await sync(tkA, { direction: 'push', orgIds: [orgB, orgC], ...W1 });
  assert(p2.status === 200 && p2.body.totalCopied === 0, `重复 push copied=0（实测 ${p2.body && p2.body.totalCopied}）`);
  assert(p2.body.totalUpdated === 0 && p2.body.totalRemoved === 0 && p2.body.totalUnchanged === 4
    && p2.body.results.every((r) => r.unchanged === 2),
    `重复 push 内容一致 → updated=0 / removed=0 / unchanged=4（实测 ${JSON.stringify(p2.body)}）`);

  // ===== 3. pull：B 排班 → 平台管理员切到 C 拉取 =====
  const cb1 = await createSchedule(tkB, { date: '2026-03-09', handlerName: '王五' });
  const cb2 = await createSchedule(tkB, { date: '2026-03-10', handlerName: '赵六' });
  assert(cb1.status === 201 && cb2.status === 201, `B 机构下周排好 2 条（${cb1.status}/${cb2.status}）`);
  const pl = await sync(tkC, { direction: 'pull', orgIds: [orgB], ...W2 });
  assert(pl.status === 200 && pl.body.totalCopied === 2 && pl.body.totalUpdated === 0 && pl.body.totalRemoved === 0,
    `C 机构从 B 拉取 copied=2 / updated=0 / removed=0（实测 ${JSON.stringify(pl.body)}）`);
  const cW2 = await listSchedules(tkC, W2.from, W2.to);
  assert(cW2.length === 2 && cW2.every((e) => Number(e.org_id) === Number(orgC) && e.createdBy === 'admin'),
    'C 机构出现拉取条目（org_id=C、createdBy=admin）');

  // ===== 4. 跨来源同日同人去重 =====
  const cb3 = await createSchedule(tkB, { date: '2026-03-11', handlerName: '孙七' });
  const cc3 = await createSchedule(tkC, { date: '2026-03-11', handlerName: '孙七' });
  assert(cb3.status === 201 && cc3.status === 201, `B / C 各排同一天同姓名「孙七」（${cb3.status}/${cc3.status}）`);
  const pl2 = await sync(tkA, { direction: 'pull', orgIds: [orgB, orgC], ...W2 });
  // C 在上一段 pull 里已收到 B 的王五/赵六，因此本次 C 来源的 3 条同键且内容一致 → unchanged
  assert(pl2.status === 200 && pl2.body.totalCopied === 3 && pl2.body.totalUpdated === 0
    && pl2.body.totalRemoved === 0 && pl2.body.totalUnchanged === 3,
    `两来源拉到 A：孙七只落一条（copied=3 / updated=0 / removed=0 / unchanged=3，实测 ${JSON.stringify(pl2.body)}）`);
  const aW2 = await listSchedules(tkA, W2.from, W2.to);
  const suns = aW2.filter((e) => e.handlerName === '孙七');
  assert(suns.length === 1, `A 机构该周「孙七」仅一条（实测 ${suns.length}）`);
  assert(aW2.length === 3, `A 机构该周共 3 条（王五/赵六/孙七，实测 ${aW2.length}）`);

  // ===== 5. 权限：非平台管理员 403（有/无 schedule.manage 两档）=====
  const mkMgr = await J(`${BASE}/api/users`, tkA, {
    method: 'POST', body: JSON.stringify({ username: 'schedmgr', name: '排班员', password: 'sched123', role: 'admin' }),
  });
  const mgrLogin = await login('schedmgr', 'sched123');
  assert(mkMgr.status === 201 && !!mgrLogin && mgrLogin.user.platformAdmin === false,
    `建非平台管理员的 admin 角色账号（有 schedule.manage，platformAdmin=${mgrLogin && mgrLogin.user.platformAdmin}）`);
  const bBefore = (await listSchedules(tkB, W1.from, W1.to)).length;
  const deny = await sync(mgrLogin.token, { direction: 'push', orgIds: [orgB], ...W1 });
  assert(deny.status === 403 && /仅平台管理员/.test((deny.body && deny.body.error) || ''),
    `有 schedule.manage 但非平台管理员 → 403「仅平台管理员可跨机构同步排班」（实测 ${deny.status}：${deny.body && deny.body.error}）`);
  const bAfter = (await listSchedules(tkB, W1.from, W1.to)).length;
  assert(bBefore === bAfter && bAfter === 2, `403 后数据零变化（B 机构仍 ${bAfter} 条）`);

  const mkRep = await J(`${BASE}/api/users`, tkA, {
    method: 'POST', body: JSON.stringify({ username: 'plain1', name: '普通人', password: 'plain123', role: 'reporter' }),
  });
  const repLogin = await login('plain1', 'plain123');
  const deny2 = await sync(repLogin.token, { direction: 'push', orgIds: [orgB], ...W1 });
  assert(deny2.status === 403, `无 schedule.manage 用户 → 403（requirePermission 先拦，实测 ${deny2.status}：${deny2.body && deny2.body.error}）`);

  // ===== 6. 参数校验 =====
  const v1 = await sync(tkA, { direction: 'push', orgIds: [orgB], to: W1.to });
  assert(v1.status === 400, `from 缺失 → 400（实测 ${v1.status}：${v1.body && v1.body.error}）`);
  const v2 = await sync(tkA, { direction: 'push', orgIds: [orgB], from: W1.from, to: '2026/03/08' });
  assert(v2.status === 400 && /to/.test(v2.body.error), `to 非法日期 → 400（实测 ${v2.body && v2.body.error}）`);
  const v3 = await sync(tkA, { direction: 'push', orgIds: [orgB], from: W1.to, to: W1.from });
  assert(v3.status === 400 && /from/.test(v3.body.error), `from 晚于 to → 400（实测 ${v3.body && v3.body.error}）`);
  const v4 = await sync(tkA, { direction: 'sideways', orgIds: [orgB], ...W1 });
  assert(v4.status === 400 && /direction/.test(v4.body.error), `direction 非法 → 400（实测 ${v4.body && v4.body.error}）`);
  const v5 = await sync(tkA, { direction: 'push', orgIds: [], ...W1 });
  assert(v5.status === 400, `orgIds 空数组 → 400（实测 ${v5.status}）`);
  const v6 = await sync(tkA, { direction: 'push', orgIds: Array.from({ length: 21 }, () => orgB), ...W1 });
  assert(v6.status === 400 && /20/.test(v6.body.error), `orgIds 超过 20 个 → 400（实测 ${v6.body && v6.body.error}）`);
  const v7 = await sync(tkA, { direction: 'push', orgIds: [999], ...W1 });
  assert(v7.status === 400 && /机构不存在或已停用/.test(v7.body.error), `orgIds 含不存在机构 → 400（实测 ${v7.body && v7.body.error}）`);
  const v8 = await sync(tkA, { direction: 'push', orgIds: [orgD], ...W1 });
  assert(v8.status === 400 && /机构不存在或已停用/.test(v8.body.error), `orgIds 含停用机构 → 400（实测 ${v8.body && v8.body.error}）`);
  const v9 = await sync(tkA, { direction: 'push', orgIds: [orgA], ...W1 });
  assert(v9.status === 200 && v9.body.totalCopied === 0 && v9.body.results.length === 0,
    `orgIds 只含当前机构 → 200 且 totalCopied=0（实测 ${v9.status}/${v9.body && v9.body.totalCopied}）`);

  // ===== 7. 源机构该时段无数据：copied=0 不报错 =====
  const empty = await sync(tkA, { direction: 'push', orgIds: [orgB], ...W3 });
  assert(empty.status === 200 && empty.body.totalCopied === 0,
    `源机构该时段无数据 → 200、copied=0（实测 ${empty.status}/${empty.body && empty.body.totalCopied}）`);

  // ===== 8. 审计日志出现 SYNC_SCHEDULE =====
  const aud = await J(`${BASE}/api/audit?action=SYNC_SCHEDULE&pageSize=50`, tkA);
  const rows = (aud.body && aud.body.rows) || (Array.isArray(aud.body) ? aud.body : []);
  assert(aud.status === 200 && rows.length > 0, `审计日志能查到 SYNC_SCHEDULE 记录（${rows.length} 条）`);
  const firstSync = rows[0] || {};
  assert(/copied=/.test(firstSync.detail || ''), `审计详情含 copied/updated/removed/unchanged 四元组汇总（实测「${firstSync.detail}」）`);

  // ===== 9. GET /api/schedules 仍按机构隔离 =====
  const iso = await createSchedule(tkA, { date: '2026-03-16', handlerName: '周八' });
  assert(iso.status === 201, `A 机构再排一条下周班（HTTP ${iso.status}）`);
  const bIso = await listSchedules(tkB, W3.from, W3.to);
  assert(bIso.length === 0, `B 机构看不到 A 机构独有条目（实测 ${bIso.length} 条）`);
  const aIso = await listSchedules(tkA, W3.from, W3.to);
  assert(aIso.length === 1 && aIso[0].handlerName === '周八', `A 机构自己能看到（实测 ${aIso.length} 条）`);

  // ================================================================
  // ===== 10. 镜像同步（v1.18.18 新语义）：源变化 → 目标对齐 =====
  // ================================================================
  // 前置：A 该时段已有「周八」（第 9 节手工排的）。再排「陈一」后 push，B 应收到 2 条。
  const mA = await createSchedule(tkA, { date: '2026-03-16', handlerName: '陈一', note: '白班' });
  assert(mA.status === 201, `A 机构排「陈一」白班（HTTP ${mA.status}）`);
  const p10 = await sync(tkA, { direction: 'push', orgIds: [orgB], ...W3 });
  assert(p10.status === 200 && p10.body.totalCopied === 2 && p10.body.totalUpdated === 0 && p10.body.totalRemoved === 0,
    `10.1 前置 push：B 新增 2 条（copied=2，实测 ${JSON.stringify(p10.body)}）`);

  // ---- 10.1 源 note 变化 → 再 push → 目标同键条目被更新（updated=1）----
  const upA = await J(`${BASE}/api/schedules/${mA.body.id}`, tkA, {
    method: 'PUT', body: JSON.stringify({ date: '2026-03-16', handlerName: '陈一', note: '白班改夜班' }),
  });
  assert(upA.status === 200, `改源「陈一」备注（HTTP ${upA.status}）`);
  const p11 = await sync(tkA, { direction: 'push', orgIds: [orgB], ...W3 });
  assert(p11.status === 200 && p11.body.totalCopied === 0 && p11.body.totalUpdated === 1
    && p11.body.totalRemoved === 0 && p11.body.totalUnchanged === 1,
    `10.1 源 note 变化 → 目标更新（copied=0/updated=1/removed=0/unchanged=1，实测 ${JSON.stringify(p11.body)}）`);
  const b10 = await listSchedules(tkB, W3.from, W3.to);
  const chenB = b10.find((e) => e.handlerName === '陈一');
  assert(!!chenB && chenB.note === '白班改夜班', `10.1 B 的「陈一」备注已被对齐为源内容（实测「${chenB && chenB.note}」）`);
  assert(b10.every((e) => e.synced === true || e.synced === 1), '10.1 B 该时段条目均带 synced 标记（同步产生）');

  // ---- 10.2 源删一条 → 再 push → 目标 synced 条目被移除（removed=1），其它条目不动 ----
  const delA = await J(`${BASE}/api/schedules/${mA.body.id}`, tkA, { method: 'DELETE' });
  assert(delA.status === 200, `源删除「陈一」（HTTP ${delA.status}）`);
  const p12 = await sync(tkA, { direction: 'push', orgIds: [orgB], ...W3 });
  assert(p12.status === 200 && p12.body.totalRemoved === 1 && p12.body.totalCopied === 0
    && p12.body.totalUpdated === 0 && p12.body.totalUnchanged === 1,
    `10.2 源删除 → 目标移除同步条目（removed=1，周八不动 unchanged=1，实测 ${JSON.stringify(p12.body)}）`);
  const b12 = await listSchedules(tkB, W3.from, W3.to);
  assert(b12.length === 1 && b12[0].handlerName === '周八',
    `10.2 B 该时段只剩「周八」（实测 ${b12.length} 条：${b12.map((e) => e.handlerName).join(',')}）`);

  // ---- 10.3 手工条目保护：同键手工条目被对齐更新（计入 updated）但永不被移除 ----
  const manualB = await createSchedule(tkB, { date: '2026-03-17', handlerName: '陈一', note: 'B手工班' });
  assert(manualB.status === 201, `B 机构手工排「陈一」（备注不同，HTTP ${manualB.status}）`);
  const mA2 = await createSchedule(tkA, { date: '2026-03-17', handlerName: '陈一', note: 'A源班' });
  assert(mA2.status === 201, `A 机构源排同日同人「陈一」（HTTP ${mA2.status}）`);
  const p13 = await sync(tkA, { direction: 'push', orgIds: [orgB], ...W3 });
  assert(p13.status === 200 && p13.body.totalUpdated === 1 && p13.body.totalCopied === 0
    && p13.body.totalRemoved === 0 && p13.body.totalUnchanged === 1,
    `10.3 同键手工条目被对齐（updated=1，周八 unchanged=1，实测 ${JSON.stringify(p13.body)}）`);
  const b13 = await listSchedules(tkB, W3.from, W3.to);
  const chen2 = b13.find((e) => e.handlerName === '陈一');
  assert(!!chen2 && chen2.note === 'A源班', `10.3 B 的手工「陈一」备注被对齐为源内容（实测「${chen2 && chen2.note}」）`);
  // 源删掉「陈一」→ 再 push：被对齐过的原手工条目（synced 仍为 0）不会被移除。
  const delA2 = await J(`${BASE}/api/schedules/${mA2.body.id}`, tkA, { method: 'DELETE' });
  assert(delA2.status === 200, `源删除「陈一」（HTTP ${delA2.status}）`);
  const p14 = await sync(tkA, { direction: 'push', orgIds: [orgB], ...W3 });
  assert(p14.status === 200 && p14.body.totalRemoved === 0 && p14.body.totalUnchanged === 1,
    `10.3 源删除后 removed=0（手工条目不参与镜像移除，实测 ${JSON.stringify(p14.body)}）`);
  const b14 = await listSchedules(tkB, W3.from, W3.to);
  const chen3 = b14.find((e) => e.handlerName === '陈一');
  assert(!!chen3 && chen3.note === 'A源班', `10.3 B 的「陈一」（原手工条目）仍在、内容保持（实测 ${b14.length} 条）`);

  // ---- 10.4 同日换人：源 周四 王二 → 冯三（王二在目标为同步产生）→ removed + copied ----
  const m4 = await createSchedule(tkA, { date: '2026-03-19', handlerName: '王二' });
  assert(m4.status === 201, `A 机构排「王二」（HTTP ${m4.status}）`);
  const p15 = await sync(tkA, { direction: 'push', orgIds: [orgB], ...W3 });
  assert(p15.status === 200 && p15.body.totalCopied === 1 && p15.body.totalRemoved === 0,
    `10.4 前置 push：王二落到 B（copied=1，实测 ${JSON.stringify(p15.body)}）`);
  const up4 = await J(`${BASE}/api/schedules/${m4.body.id}`, tkA, {
    method: 'PUT', body: JSON.stringify({ date: '2026-03-19', handlerName: '冯三', handlerUsername: '', note: '' }),
  });
  assert(up4.status === 200, `源同日换人：王二 → 冯三（HTTP ${up4.status}）`);
  const p16 = await sync(tkA, { direction: 'push', orgIds: [orgB], ...W3 });
  assert(p16.status === 200 && p16.body.totalRemoved === 1 && p16.body.totalCopied === 1 && p16.body.totalUpdated === 0,
    `10.4 同日换人：目标王二（同步产生）removed=1 + 冯三 copied=1（实测 ${JSON.stringify(p16.body)}）`);
  const b16 = await listSchedules(tkB, W3.from, W3.to);
  assert(!b16.some((e) => e.handlerName === '王二') && b16.some((e) => e.handlerName === '冯三'),
    `10.4 B 该时段已无「王二」、出现「冯三」（实测 ${b16.map((e) => e.handlerName).join(',')}）`);
}

try {
  await main();
} catch (e) {
  failed++;
  console.error('  FAIL 套件异常：', (e && e.message) || e);
} finally {
  cleanup();
}

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
