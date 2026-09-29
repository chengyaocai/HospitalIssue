// v1.18.25 端到端：**审核结果站内通知（notifyAuditResult）**。
//
// 用户反馈：审核通过/不通过后登记人收不到站内通知。根因有二：
//   1. 机构归属 bug（主因）：problems.js 审核端点调 sendNotification 漏传 orgId，
//      通知存储把缺省 org_id 落默认机构 1 → 审核发生在非默认机构（如妇保医院）时，
//      通知落到默认机构，登记人（req.orgId 过滤）永远看不到 —— 回归钉死：机构 2
//      审核机构 2 的问题，通知 org_id 必须为 2，且机构 2 视角可见、机构 1 视角不可见。
//   2. 覆盖面缺口：只通知登记人（createdBy / 老数据按 registrar 反查），提出人
//      （rec.reporter 自由文本姓名）不收通知 → 花名册反查后同样定向，同人去重。
//
// 钉住的规则：
//   - 通过 = 「问题审核通过」/「「标题」已通过审核（审核人：xxx）」；
//     不通过 = 「问题审核不通过」/「「标题」未通过审核：原因（审核人：xxx）」；
//   - from 为审核人账号；unreadCount 对收件人 +1；
//   - 提出人与登记人同一账号只发一条；提出人无对应账号时只有登记人收到；
//   - 老数据无 createdBy、registrar 可反查 → 通知送达；
//   - 无任何可通知账号 → 审核本身成功（200），不 500。
//
// 运行：cd backend && node test/audit-notify.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3760 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `auditnotify-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `auditnotify-uploads-${stamp}`);

// 预置两条「老数据」（v1.2 之前的存量记录：无 createdBy 字段）：
//  - id=1：registrar=张三 / reporter=李四，均可按姓名在花名册反查 → 审核后两人都应收到；
//  - id=2：registrar=查无此人 / reporter=也不存在，无可通知账号 → 审核须成功且不产生通知。
const LEGACY_OK = {
  id: 1, org_id: 1, title: '老数据-HIS打印故障', department: '内科',
  reporter: '李四', type: '故障', severity: '低', description: '存量数据，无 createdBy',
  registrar: '张三', status: '待处理', created_at: '2024-01-01T08:00:00.000Z',
};
const LEGACY_NONE = {
  id: 2, org_id: 1, title: '老数据-查无此人', department: '外科',
  reporter: '也不存在', type: '咨询', severity: '中', description: '无可通知账号的存量数据',
  registrar: '查无此人', status: '待处理', created_at: '2024-01-02T08:00:00.000Z',
};

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'audit-notify-test-secret',
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
  return r.body && r.body.token ? r.body.token : null;
};
const switchOrg = async (token, orgId) => {
  const r = await J(`${BASE}/api/auth/switch-org`, token, { method: 'POST', body: JSON.stringify({ orgId }) });
  return r.status === 200 && r.body && r.body.token ? r.body.token : null;
};
const createProblem = (token, fields) =>
  J(`${BASE}/api/problems`, token, { method: 'POST', body: JSON.stringify(fields) });
const auditProblem = (token, id, result, reason) =>
  J(`${BASE}/api/problems/${id}/audit`, token, { method: 'POST', body: JSON.stringify({ result, reason }) });
const listNotif = (token) => J(`${BASE}/api/notifications`, token);
const unreadOf = async (token) => {
  const r = await J(`${BASE}/api/notifications/unread-count`, token);
  return r.body ? r.body.unread : -1;
};
const problem = (title, reporter) => ({
  title, department: '信息科', reporter, type: '故障', severity: '低', description: '测试问题：' + title,
});

async function main() {
  // 预置老数据：必须在服务首次加载 issues JSON 之前写入（devRepo 惰性加载）
  await fs.promises.writeFile(files.DEV_DB_PATH, JSON.stringify([LEGACY_OK, LEGACY_NONE], null, 2), 'utf8');

  await waitReady();

  // ===== 0. 登录 + 建账号（reg1=登记人张三 / rep1=提出人李四 / reg2=机构2登记人王五）=====
  const admin = await login('admin', 'admin123');
  assert(!!admin, '管理员登录成功');
  for (const [u, n] of [['reg1', '张三'], ['rep1', '李四'], ['reg2', '王五']]) {
    const mk = await J(`${BASE}/api/users`, admin, {
      method: 'POST', body: JSON.stringify({ username: u, name: n, password: u + '123', role: 'reporter' }),
    });
    assert(mk.status === 201, `创建账号 ${u}（${n}，HTTP ${mk.status}）`);
  }
  const tk1 = await login('reg1', 'reg1123');
  const tkR = await login('rep1', 'rep1123');
  const tk2 = await login('reg2', 'reg2123');
  assert(!!tk1 && !!tkR && !!tk2, 'reg1 / rep1 / reg2 登录成功');

  // ===== 1. 默认机构审核通过 → 登记人 + 提出人都收到通知 =====
  const p1 = await createProblem(tk1, problem('打印机故障一', '李四'));
  assert(p1.status === 201 && p1.body.id, `reg1 登记问题（HTTP ${p1.status}，id=${p1.body && p1.body.id}）`);
  const a1 = await auditProblem(admin, p1.body.id, 'approve');
  assert(a1.status === 200 && a1.body.audit_status === '已通过', `管理员审核通过（HTTP ${a1.status}，状态=${a1.body && a1.body.audit_status}）`);

  const n1 = await listNotif(tk1);
  const row1 = (n1.body.rows || [])[0] || {};
  assert((n1.body.rows || []).length === 1, `登记人 reg1 收到 1 条通知（实测 ${n1.body.rows.length} 条）`);
  assert(row1.title === '问题审核通过', `通知标题=「问题审核通过」（实测「${row1.title}」）`);
  assert(
    typeof row1.body === 'string' && row1.body.includes('打印机故障一') && row1.body.includes('已通过审核') && row1.body.includes('审核人：SystemAdmin'),
    `通知正文含标题/「已通过审核」/审核人（实测「${row1.body}」）`,
  );
  assert(row1.from === 'admin', `通知 from=审核人账号 admin（实测「${row1.from}」）`);
  assert((await unreadOf(tk1)) === 1, '登记人 unreadCount +1（=1）');

  const nr = await listNotif(tkR);
  assert((nr.body.rows || []).length === 1 && (nr.body.rows[0] || {}).title === '问题审核通过' && (await unreadOf(tkR)) === 1,
    `提出人 rep1（花名册同名账号「李四」）也收到 1 条审核通过通知`);

  // ===== 2. 审核不通过 → 通知含原因；无账号的提出人不发 =====
  const p2 = await createProblem(tk1, problem('系统卡顿二', '赵六'));
  assert(p2.status === 201, `reg1 再登记问题（提出人「赵六」无对应账号，HTTP ${p2.status}）`);
  const a2 = await auditProblem(admin, p2.body.id, 'reject', '描述不清，请补充截图');
  assert(a2.status === 200 && a2.body.audit_status === '不通过', `管理员审核不通过（HTTP ${a2.status}，状态=${a2.body && a2.body.audit_status}）`);

  const n2 = await listNotif(tk1);
  const rejRow = (n2.body.rows || []).find((r) => r.title === '问题审核不通过') || {};
  assert((n2.body.rows || []).length === 2, `reg1 累计收到 2 条通知（实测 ${n2.body.rows.length} 条）`);
  assert(
    typeof rejRow.body === 'string' && rejRow.body.includes('系统卡顿二') && rejRow.body.includes('未通过审核：描述不清，请补充截图') && rejRow.body.includes('审核人：SystemAdmin'),
    `不通过通知正文含标题/原因/审核人（实测「${rejRow.body}」）`,
  );
  const nr2 = await listNotif(tkR);
  assert((nr2.body.rows || []).length === 1, `提出人「赵六」无对应账号 → rep1 仍只有 1 条（实测 ${nr2.body.rows.length} 条）`);

  // ===== 3. 提出人与登记人同一账号 → 去重只发一条 =====
  const p3 = await createProblem(tk1, problem('药房叫号异常三', '张三'));
  assert(p3.status === 201, `reg1 登记问题（提出人=本人「张三」，HTTP ${p3.status}）`);
  const a3 = await auditProblem(admin, p3.body.id, 'approve');
  assert(a3.status === 200, `管理员审核通过（HTTP ${a3.status}）`);
  const n3 = await listNotif(tk1);
  const sameTitle = (n3.body.rows || []).filter((r) => r.title === '问题审核通过' && r.body.includes('药房叫号异常三'));
  assert((n3.body.rows || []).length === 3 && sameTitle.length === 1,
    `登记人=提出人同一账号只发 1 条（该问题通知 ${sameTitle.length} 条 / 累计 ${n3.body.rows.length} 条，去重前应为 4）`);
  assert((await unreadOf(tk1)) === 3, 'reg1 unreadCount=3（与通知条数一致）');

  // ===== 4. 机构 2 审核机构 2 的问题 → 通知 org_id=2（回归钉死，最关键）=====
  const orgCreate = await J(`${BASE}/api/orgs`, admin, { method: 'POST', body: JSON.stringify({ name: '妇保医院' }) });
  assert(orgCreate.status === 201 && String(orgCreate.body.id) === '2', `创建机构「妇保医院」id=2（HTTP ${orgCreate.status}，id=${orgCreate.body && orgCreate.body.id}）`);
  const usersList = await J(`${BASE}/api/users`, admin);
  const rawUsers = Array.isArray(usersList.body) ? usersList.body : (usersList.body && usersList.body.rows) || [];
  const reg2Id = (rawUsers.find((u) => u.username === 'reg2') || {}).id;
  const addM = await J(`${BASE}/api/orgs/2/members`, admin, { method: 'POST', body: JSON.stringify({ userId: reg2Id, role: 'reporter' }) });
  assert(addM.status === 200, `reg2 加入机构 2（HTTP ${addM.status}）`);
  const tk2o = await switchOrg(tk2, 2);
  assert(!!tk2o, 'reg2 切换到机构 2 获得新 token');

  const p4 = await createProblem(tk2o, problem('妇保LIS接口中断', '王五'));
  assert(p4.status === 201 && String(p4.body.org_id) === '2', `reg2 在机构 2 登记问题（org_id=${p4.body && p4.body.org_id}）`);
  const tkAo = await switchOrg(admin, 2);
  assert(!!tkAo, '管理员切换到机构 2');
  const a4 = await auditProblem(tkAo, p4.body.id, 'approve');
  assert(a4.status === 200, `机构 2 内审核通过（HTTP ${a4.status}）`);

  const n4 = await listNotif(tk2o);
  const row4 = (n4.body.rows || []).find((r) => r.title === '问题审核通过' && r.body.includes('妇保LIS接口中断'));
  assert(!!row4, `机构 2 视角：登记人 reg2 收到审核通过通知（实测 ${(n4.body.rows || []).length} 条）`);
  assert(row4 && row4.from === 'admin', `机构 2 通知 from=admin（实测「${row4 && row4.from}」）`);
  assert((await unreadOf(tk2o)) === 1, '机构 2 视角 reg2 unreadCount=1');

  // 机构 1 视角不可见：reg2 切回机构 1、reg1 从未见过
  const tk2b = await switchOrg(tk2, 1);
  const n4b = await listNotif(tk2b);
  assert((n4b.body.rows || []).every((r) => !(r.body || '').includes('妇保LIS接口中断')) && (await unreadOf(tk2b)) === 0,
    '机构 1 视角：reg2 看不到机构 2 的审核通知（unreadCount=0）');
  const n4c = await listNotif(tk1);
  assert((n4c.body.rows || []).every((r) => !(r.body || '').includes('妇保LIS接口中断')),
    '默认机构用户 reg1 同样看不到机构 2 的审核通知');

  // 落盘钉死：通知记录 org_id 必须 = 2（存储层缺省落默认机构的回归根因）
  const notifRaw = JSON.parse(await fs.promises.readFile(files.NOTIFICATIONS_DEV_PATH, 'utf8'));
  const org2Notif = notifRaw.find((r) => r.to === 'reg2' && (r.body || '').includes('妇保LIS接口中断'));
  assert(!!org2Notif && Number(org2Notif.org_id) === 2, `落盘数据：机构 2 审核通知 org_id=2（实测 ${org2Notif && org2Notif.org_id}）`);

  // ===== 5. 老数据（无 createdBy）按 registrar / reporter 姓名反查 =====
  const a5 = await auditProblem(admin, LEGACY_OK.id, 'approve');
  assert(a5.status === 200, `老数据（无 createdBy，registrar=张三/reporter=李四）审核通过（HTTP ${a5.status}）`);
  const n5 = await listNotif(tk1);
  assert((n5.body.rows || []).length === 4 && (n5.body.rows || []).some((r) => (r.body || '').includes('老数据-HIS打印故障')),
    `老数据：登记人按 registrar 姓名反查送达（reg1 累计 4 条，实测 ${n5.body.rows.length} 条）`);
  const n5r = await listNotif(tkR);
  assert((n5r.body.rows || []).length === 2 && (n5r.body.rows || []).some((r) => (r.body || '').includes('老数据-HIS打印故障')),
    `老数据：提出人按 reporter 姓名反查送达（rep1 累计 2 条，实测 ${n5r.body.rows.length} 条）`);

  // ===== 6. 无任何可通知账号 → 审核本身成功，不 500、不产生通知 =====
  const a6 = await auditProblem(admin, LEGACY_NONE.id, 'reject', '无法定位登记人');
  assert(a6.status === 200 && a6.body.audit_status === '不通过', `无可通知账号的老数据审核仍成功（HTTP ${a6.status}，状态=${a6.body && a6.body.audit_status}）`);
  const n6 = await listNotif(tk1);
  const n6r = await listNotif(tkR);
  assert((n6.body.rows || []).length === 4 && (n6r.body.rows || []).length === 2,
    `无可通知账号 → 不产生任何通知（reg1=${n6.body.rows.length} / rep1=${n6r.body.rows.length}，均不变）`);
  const notifRaw2 = JSON.parse(await fs.promises.readFile(files.NOTIFICATIONS_DEV_PATH, 'utf8'));
  assert(!notifRaw2.some((r) => (r.body || '').includes('老数据-查无此人')), '落盘数据：无收件人的审核未写入任何通知');
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
