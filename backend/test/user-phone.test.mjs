// v1.18.17 端到端：用户增加「联系电话」。
//
// 规则钉住：
//   1) 新建用户可选 phone：trim 后 ≤20 字符，超长 400「联系电话过长」，不传 / 空存 ''；
//      GET /api/users 花名册行内带 phone；
//   2) PUT /api/users/:id/phone：权限走 loadOwnableTarget（与重置密码同一条账号级边界）——
//      平台管理员可改任意账号（含多机构公司用户）；机构管理员仅限「仅属本机构」账号；
//      多机构公司用户 / 跨机构专属账号一律 404（不泄漏存在性）；未登录 401；
//   3) 审计日志含 UPDATE_USER_PHONE，且**电话已脱敏**（含 ****，不含完整新号码）；
//   4) 联动：company 用户设 phone 后，其所在机构 GET /api/config 的 handlers 该项
//      phone === 用户电话（v1.18.16 派生打通）；hospital 用户不进 handlers（回归）。
//
// 运行：cd backend && node test/user-phone.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3920 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `userphone-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `userphone-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'user-phone-test-secret',
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
const login = async (username, password) => J(`${BASE}/api/auth/login`, null, {
  method: 'POST', body: JSON.stringify({ username, password }),
});
const rosterFind = async (tk, id) => {
  const r = await J(`${BASE}/api/users`, tk);
  return { res: r, row: (r.body || []).find((u) => String(u.id) === String(id)) };
};

async function main() {
  await waitReady();

  // ===== 0. 平台管理员登录 + 建第二个机构 =====
  const admin = await login('admin', 'admin123');
  assert(admin.status === 200 && admin.body.user.platformAdmin === true, `平台管理员登录成功（HTTP ${admin.status}）`);
  const tk = admin.body.token;

  const mk = await J(`${BASE}/api/orgs`, tk, { method: 'POST', body: JSON.stringify({ code: 'zyy', name: '海盐县中医院' }) });
  assert(mk.status === 201 && mk.body.id, `新建机构 2 成功（id=${mk.body && mk.body.id}）`);
  const org2 = mk.body.id;

  // ===== 1. 创建用户带 phone（前后空格被 trim）→ 响应与花名册均正确 =====
  const mkU1 = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'u_phone', name: '有电话的人', password: 'up123456', phone: '  13812348026  ' }),
  });
  assert((mkU1.status === 201 || mkU1.status === 200) && mkU1.body.phone === '13812348026',
    `创建用户带 phone，响应已 trim（实测 ${mkU1.body && JSON.stringify(mkU1.body.phone)}）`);
  const u1 = mkU1.body;
  const r1 = await rosterFind(tk, u1.id);
  assert(r1.res.status === 200 && r1.row && r1.row.phone === '13812348026', `花名册行内 u_phone.phone=13812348026（实测 ${r1.row && r1.row.phone}）`);

  // ===== 2. 不传 phone → ''；21 字 → 400「联系电话过长」 =====
  const mkU2 = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'u_nophone', name: '没电话的人', password: 'up123456' }),
  });
  assert((mkU2.status === 201 || mkU2.status === 200) && mkU2.body.phone === '',
    `不传 phone 的新账号存空串（实测 ${mkU2.body && JSON.stringify(mkU2.body.phone)}）`);
  const tooLong = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'u_toolong', name: '超长电话', password: 'up123456', phone: '1'.repeat(21) }),
  });
  assert(tooLong.status === 400 && tooLong.body.error === '联系电话过长',
    `创建时 phone 超 20 字被拒（HTTP ${tooLong.status}：${tooLong.body && tooLong.body.error}）`);

  // ===== 3. 组织好角色：机构管理员 mgr1（本机构专属）、公司用户 vendor1（双机构）、机构 2 专属账号 =====
  const mkMgr = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'mgr1', name: '信息科管理员', password: 'mgr12345', role: 'admin' }),
  });
  assert(mkMgr.status === 201 || mkMgr.status === 200, `新建机构管理员 mgr1（HTTP ${mkMgr.status}）`);
  const mgr = await login('mgr1', 'mgr12345');
  assert(mgr.status === 200 && mgr.body.user.platformAdmin === false, `mgr1 登录成功且非平台管理员`);
  const mgrTk = mgr.body.token;

  const mkVendor = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'vendor1', name: '设备厂商小王', password: 'vendor123', role: 'admin', userType: 'company' }),
  });
  assert((mkVendor.status === 201 || mkVendor.status === 200) && mkVendor.body.userType === 'company', `平台管理员创建公司用户 vendor1（无电话 → phone=''）`);
  assert(mkVendor.body.phone === '', `公司用户创建时未传 phone 存空串（实测 ${JSON.stringify(mkVendor.body.phone)}）`);
  const vendorId = mkVendor.body.id;
  const addOrg2 = await J(`${BASE}/api/users/${vendorId}/memberships`, tk, {
    method: 'POST', body: JSON.stringify({ orgId: org2, role: 'reporter' }),
  });
  assert(addOrg2.status === 200, `vendor1 加入机构 2 → 成为多机构公司用户（HTTP ${addOrg2.status}）`);

  const swAdmin = await J(`${BASE}/api/auth/switch-org`, tk, { method: 'POST', body: JSON.stringify({ orgId: org2 }) });
  const tk2 = swAdmin.body.token;
  const mkOrg2User = await J(`${BASE}/api/users`, tk2, {
    method: 'POST', body: JSON.stringify({ username: 'org2admin', name: '中医院管理员', password: 'org212345', role: 'admin' }),
  });
  assert(mkOrg2User.status === 201 || mkOrg2User.status === 200, `在机构 2 新建专属账号 org2admin（HTTP ${mkOrg2User.status}）`);
  const org2UserId = mkOrg2User.body.id;

  // ===== 4. PUT /:id/phone —— 平台管理员可改任意账号（含多机构公司用户）=====
  const setVendor = await J(`${BASE}/api/users/${vendorId}/phone`, tk, { method: 'PUT', body: JSON.stringify({ phone: '13900001111' }) });
  assert(setVendor.status === 200 && setVendor.body.phone === '13900001111',
    `平台管理员改多机构公司用户电话 → 200（实测 ${setVendor.status}/${setVendor.body && setVendor.body.phone}）`);
  const rV = await rosterFind(tk, vendorId);
  assert(rV.row && rV.row.phone === '13900001111', `花名册同步更新 vendor1.phone=13900001111（实测 ${rV.row && rV.row.phone}）`);

  const setOrg2User = await J(`${BASE}/api/users/${org2UserId}/phone`, tk, { method: 'PUT', body: JSON.stringify({ phone: '13722223333' }) });
  assert(setOrg2User.status === 200, `平台管理员改其它机构专属账号电话 → 200（实测 ${setOrg2User.status}）`);

  // ===== 5. 机构管理员的边界（与重置密码同一条 loadOwnableTarget 链）=====
  const denyMulti = await J(`${BASE}/api/users/${vendorId}/phone`, mgrTk, { method: 'PUT', body: JSON.stringify({ phone: '13555556666' }) });
  assert(denyMulti.status === 404, `机构管理员改「多机构公司用户」电话 → 404（实测 ${denyMulti.status}）`);
  assert(denyMulti.body && denyMulti.body.error === '用户不存在', `404 文案与既有约定一致「用户不存在」（实测 ${denyMulti.body && denyMulti.body.error}）`);
  const denyCross = await J(`${BASE}/api/users/${org2UserId}/phone`, mgrTk, { method: 'PUT', body: JSON.stringify({ phone: '13555556666' }) });
  assert(denyCross.status === 404, `机构管理员改「跨机构专属账号」电话 → 404（实测 ${denyCross.status}）`);

  // 机构管理员改「仅属本机构」账号 → 200（用 mgr1 自建的专属账号 rep1）
  const mkRep = await J(`${BASE}/api/users`, mgrTk, {
    method: 'POST', body: JSON.stringify({ username: 'rep1', name: '本机构登记员', password: 'rep12345' }),
  });
  assert(mkRep.status === 201 || mkRep.status === 200, `机构管理员新建本机构专属账号 rep1（HTTP ${mkRep.status}）`);
  const okOwn = await J(`${BASE}/api/users/${mkRep.body.id}/phone`, mgrTk, { method: 'PUT', body: JSON.stringify({ phone: '13666667777' }) });
  assert(okOwn.status === 200 && okOwn.body.phone === '13666667777',
    `机构管理员改「仅属本机构」账号电话 → 200（实测 ${okOwn.status}/${okOwn.body && okOwn.body.phone}）`);
  const rRep = await rosterFind(mgrTk, mkRep.body.id);
  assert(rRep.row && rRep.row.phone === '13666667777', `机构管理员视角花名册同步更新 rep1.phone（实测 ${rRep.row && rRep.row.phone}）`);

  // PUT phone 超 20 字 → 400
  const denyLong = await J(`${BASE}/api/users/${mkRep.body.id}/phone`, mgrTk, { method: 'PUT', body: JSON.stringify({ phone: '2'.repeat(21) }) });
  assert(denyLong.status === 400 && denyLong.body.error === '联系电话过长',
    `PUT phone 超 20 字被拒（HTTP ${denyLong.status}：${denyLong.body && denyLong.body.error}）`);

  // ===== 6. 未登录 → 401 =====
  const noAuth = await J(`${BASE}/api/users/${vendorId}/phone`, null, { method: 'PUT', body: JSON.stringify({ phone: '13000000000' }) });
  assert(noAuth.status === 401, `未登录改电话 → 401（实测 ${noAuth.status}）`);

  // ===== 7. 审计日志：UPDATE_USER_PHONE 且电话脱敏 =====
  const auditList = await J(`${BASE}/api/audit?action=UPDATE_USER_PHONE`, tk);
  const rows = (auditList.body && auditList.body.rows) || [];
  assert(auditList.status === 200 && rows.length >= 3, `审计日志含 UPDATE_USER_PHONE（实测 ${rows.length} 条）`);
  const vRow = rows.find((a) => a.target === 'vendor1');
  assert(!!vRow && /\*\*\*\*/.test(vRow.detail || ''), `vendor1 的审计详情含脱敏星号（实测 ${vRow && vRow.detail}）`);
  assert(!!vRow && !(vRow.detail || '').includes('13900001111'), `审计详情不含完整明文新号码`);
  const repRow = rows.find((a) => a.target === 'rep1');
  assert(!!repRow && /\*\*\*\*/.test(repRow.detail || '') && !(repRow.detail || '').includes('13666667777'),
    `rep1 的审计详情同样脱敏（实测 ${repRow && repRow.detail}）`);

  // ===== 8. 联动：handlers 自动带出电话（v1.18.16 派生 × v1.18.17 phone）=====
  const cfg1 = await J(`${BASE}/api/config`, tk);
  const h1 = ((cfg1.body && cfg1.body.handlers) || []).find((h) => h.empId === 'vendor1');
  assert(!!h1 && h1.phone === '13900001111', `机构 1 config.handlers 中 vendor1.phone=13900001111（实测 ${h1 && JSON.stringify(h1.phone)}）`);
  const cfg2 = await J(`${BASE}/api/config`, tk2);
  const h2 = ((cfg2.body && cfg2.body.handlers) || []).find((h) => h.empId === 'vendor1');
  assert(!!h2 && h2.phone === '13900001111', `机构 2 config.handlers 中 vendor1 同样带出电话（实测 ${h2 && JSON.stringify(h2.phone)}）`);
  // 未设电话的公司用户（若有）电话为空串而非 undefined —— 用 rep1 是 hospital 用户做回归：
  const mgrInHandlers = ((cfg1.body && cfg1.body.handlers) || []).some((h) => h.empId === 'mgr1');
  assert(!mgrInHandlers, `hospital 用户 mgr1 不进 handlers（回归确认）`);
  const repInHandlers = ((cfg1.body && cfg1.body.handlers) || []).some((h) => h.empId === 'rep1');
  assert(!repInHandlers, `hospital 用户 rep1 不进 handlers（回归确认）`);
  const allPhonesOk = ((cfg1.body && cfg1.body.handlers) || []).every((h) => typeof h.phone === 'string');
  assert(allPhonesOk, `handlers 每项 phone 均为字符串（空则 ''，不出现 undefined）`);
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
