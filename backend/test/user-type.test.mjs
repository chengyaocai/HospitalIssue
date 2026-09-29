// v1.18.12 端到端：用户管理增加「公司用户 / 院方用户」区分，公司用户支持分配多家机构。
//
// 规则钉住：
//   1) 存量/新建账号默认 userType='hospital'（GET /api/users 行内带该字段）；
//   2) 仅平台管理员可创建 / 改为公司用户；机构管理员创建 company → 400；
//   3) 公司用户可归属多机构：双方机构花名册都可见、各机构内角色独立生效（/auth/me + 切机构）；
//   4) 给院方用户加第二机构 → 400（文案匹配）；先改为公司用户再加 → 200；
//   5) 公司 → 院方在成员关系 >1 时 400；移到只剩 1 个后成功；
//   6) 移光全部机构 → 400「用户至少需要属于一个机构」；
//   7) 非平台管理员调 memberships / type 接口 → 404；跨机构 id 不可见性不破坏；
//   8) 用户类型变更进审计日志。
//
// 运行：cd backend && node test/user-type.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3520 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `usertype-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `usertype-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'user-type-test-secret',
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

async function main() {
  await waitReady();

  // ===== 0. 平台管理员登录 + 建第二个机构 =====
  const admin = await login('admin', 'admin123');
  assert(admin.status === 200 && admin.body.user.platformAdmin === true, `平台管理员登录成功（HTTP ${admin.status}）`);
  const tk = admin.body.token;

  const mk = await J(`${BASE}/api/orgs`, tk, { method: 'POST', body: JSON.stringify({ code: 'zyy', name: '海盐县中医院' }) });
  assert(mk.status === 201 && mk.body.id, `新建机构 2 成功（id=${mk.body && mk.body.id}）`);
  const org2 = mk.body.id;

  // ===== 1. 存量/新建默认 userType='hospital' =====
  const roster = await J(`${BASE}/api/users`, tk);
  const adminRow = (roster.body || []).find((u) => String(u.id) === String(admin.body.user.id));
  assert(roster.status === 200 && adminRow && adminRow.userType === 'hospital',
    `花名册行带 userType，存量账号默认院方（实测 ${adminRow && adminRow.userType}）`);

  // ===== 2. 机构管理员创建 company → 400；平台管理员创建 company → 200 =====
  // 机构管理员：admin 在机构 1 新建一个非平台管理员的 admin 角色账号（该角色具备 user.manage）。
  const mkMgr = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'mgr1', name: '信息科管理员', password: 'mgr12345', role: 'admin' }),
  });
  assert(mkMgr.status === 201 || mkMgr.status === 200, `新建机构管理员 mgr1（HTTP ${mkMgr.status}）`);
  assert(mkMgr.body && mkMgr.body.userType === 'hospital', `未传 userType 的新账号默认院方（实测 ${mkMgr.body && mkMgr.body.userType}）`);

  const mgr = await login('mgr1', 'mgr12345');
  assert(mgr.status === 200 && mgr.body.user.platformAdmin === false, `mgr1 登录成功且非平台管理员（platformAdmin=${mgr.body.user.platformAdmin}）`);
  const mgrTk = mgr.body.token;

  const denyCreate = await J(`${BASE}/api/users`, mgrTk, {
    method: 'POST', body: JSON.stringify({ username: 'bad_vendor', password: 'vendor123', userType: 'company' }),
  });
  assert(denyCreate.status === 400 && denyCreate.body.error === '仅平台管理员可创建公司用户',
    `机构管理员创建公司用户被拒（HTTP ${denyCreate.status}：${denyCreate.body && denyCreate.body.error}）`);

  const mkVendor = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'vendor1', name: '设备厂商小王', password: 'vendor123', role: 'admin', userType: 'company' }),
  });
  assert((mkVendor.status === 201 || mkVendor.status === 200) && mkVendor.body.userType === 'company',
    `平台管理员创建公司用户 vendor1（HTTP ${mkVendor.status}，userType=${mkVendor.body && mkVendor.body.userType}）`);
  const vendorId = mkVendor.body.id;

  const roster2 = await J(`${BASE}/api/users`, tk);
  const vendorRow = (roster2.body || []).find((u) => String(u.id) === String(vendorId));
  assert(!!vendorRow && vendorRow.userType === 'company', `花名册行内 vendor1.userType=company（实测 ${vendorRow && vendorRow.userType}）`);

  // ===== 3. 公司用户分配第二机构：双方花名册可见、机构内角色独立生效 =====
  const addOrg2 = await J(`${BASE}/api/users/${vendorId}/memberships`, tk, {
    method: 'POST', body: JSON.stringify({ orgId: org2, role: 'reporter' }),
  });
  assert(addOrg2.status === 200, `平台管理员把 vendor1 加入机构 2（HTTP ${addOrg2.status}）`);

  const ms = await J(`${BASE}/api/users/${vendorId}/memberships`, tk);
  assert(ms.status === 200 && Array.isArray(ms.body) && ms.body.length === 2,
    `memberships 返回 2 条成员关系（实测 ${ms.status}、${Array.isArray(ms.body) ? ms.body.length : '非数组'}）`);
  const m2 = (ms.body || []).find((x) => String(x.orgId) === String(org2));
  assert(!!m2 && m2.orgName === '海盐县中医院' && m2.role === 'reporter' && m2.orgActive === true,
    `成员关系附机构名/角色/启用状态（实测 ${m2 && m2.orgName}/${m2 && m2.role}/${m2 && m2.orgActive}）`);

  // 双方机构花名册都能看到
  const rosterOrg1 = await J(`${BASE}/api/users`, tk);
  assert((rosterOrg1.body || []).some((u) => String(u.id) === String(vendorId)), '机构 1 花名册包含 vendor1');
  const swAdmin = await J(`${BASE}/api/auth/switch-org`, tk, { method: 'POST', body: JSON.stringify({ orgId: org2 }) });
  const tk2 = swAdmin.body.token;
  const rosterOrg2 = await J(`${BASE}/api/users`, tk2);
  assert((rosterOrg2.body || []).some((u) => String(u.id) === String(vendorId)), '机构 2 花名册包含 vendor1');

  // 机构内角色独立生效：vendor1 在机构 1 是 admin、机构 2 是 reporter
  const vLogin = await login('vendor1', 'vendor123');
  assert(vLogin.status === 200 && vLogin.body.user.role === 'admin',
    `vendor1 登录后当前机构（机构 1）内角色 admin（实测 ${vLogin.body.user.role}）`);
  const swVendor = await J(`${BASE}/api/auth/switch-org`, vLogin.body.token, { method: 'POST', body: JSON.stringify({ orgId: org2 }) });
  assert(swVendor.status === 200 && swVendor.body.user.role === 'reporter',
    `vendor1 切到机构 2 后 /auth/me 机构内角色 reporter（实测 ${swVendor.body && swVendor.body.user && swVendor.body.user.role}）`);
  const vMe = await J(`${BASE}/api/auth/me`, swVendor.body.token);
  assert(vMe.status === 200 && vMe.body.user.role === 'reporter' && String(vMe.body.org.id) === String(org2),
    `vendor1 在机构 2 的 /auth/me：role=reporter、org 正确（实测 ${vMe.body.user.role}/${vMe.body.org.name}）`);
  const vMe1 = await J(`${BASE}/api/auth/me`, vLogin.body.token);
  assert(vMe1.status === 200 && vMe1.body.user.role === 'admin' && String(vMe1.body.org.id) !== String(org2),
    `vendor1 在机构 1 的 /auth/me：role=admin（实测 ${vMe1.body.user.role}）← 各机构角色独立`);

  // ===== 4. 院方用户加第二机构 → 400；先改 company 再加 → 200 =====
  const denyAdd = await J(`${BASE}/api/users/${mkMgr.body.id}/memberships`, tk, {
    method: 'POST', body: JSON.stringify({ orgId: org2, role: 'reporter' }),
  });
  assert(denyAdd.status === 400 && /院方用户只能属于一个机构，如需加入多机构请先改为公司用户/.test(denyAdd.body.error || ''),
    `给院方用户加第二机构被拒（HTTP ${denyAdd.status}：${denyAdd.body && denyAdd.body.error}）`);

  const toCompany = await J(`${BASE}/api/users/${mkMgr.body.id}/type`, tk, { method: 'PUT', body: JSON.stringify({ userType: 'company' }) });
  assert(toCompany.status === 200, `平台管理员把 mgr1 改为公司用户（HTTP ${toCompany.status}）`);
  const addAgain = await J(`${BASE}/api/users/${mkMgr.body.id}/memberships`, tk, {
    method: 'POST', body: JSON.stringify({ orgId: org2, role: 'reporter' }),
  });
  assert(addAgain.status === 200, `改为公司用户后加入机构 2 成功（HTTP ${addAgain.status}）`);

  // ===== 5. company → hospital 在成员关系 >1 时 400；移到只剩 1 个后成功 =====
  const denyHospital = await J(`${BASE}/api/users/${mkMgr.body.id}/type`, tk, { method: 'PUT', body: JSON.stringify({ userType: 'hospital' }) });
  assert(denyHospital.status === 400 && /该公司用户仍属于 2 个机构，请先将其移出多余机构/.test(denyHospital.body.error || ''),
    `仍属 2 个机构时改回院方被拒（HTTP ${denyHospital.status}：${denyHospital.body && denyHospital.body.error}）`);
  const rmOrg2 = await J(`${BASE}/api/users/${mkMgr.body.id}/memberships/${org2}`, tk, { method: 'DELETE' });
  assert(rmOrg2.status === 200, `移出机构 2 成功（HTTP ${rmOrg2.status}）`);
  const toHospital = await J(`${BASE}/api/users/${mkMgr.body.id}/type`, tk, { method: 'PUT', body: JSON.stringify({ userType: 'hospital' }) });
  assert(toHospital.status === 200, `只剩 1 个机构后改回院方成功（HTTP ${toHospital.status}）`);

  // ===== 6. DELETE 移光所有机构 → 400 =====
  const rmLast = await J(`${BASE}/api/users/${mkMgr.body.id}/memberships/1`, tk, { method: 'DELETE' });
  assert(rmLast.status === 400 && rmLast.body.error === '用户至少需要属于一个机构',
    `移光全部机构被拒（HTTP ${rmLast.status}：${rmLast.body && rmLast.body.error}）`);

  // ===== 7. 非平台管理员调 memberships/type 接口 → 404；跨机构 id 不可见性 =====
  const mgrFresh = await login('mgr1', 'mgr12345');
  const mgrTk2 = mgrFresh.body.token;
  const f1 = await J(`${BASE}/api/users/${vendorId}/memberships`, mgrTk2);
  assert(f1.status === 404, `机构管理员 GET memberships → 404（实测 ${f1.status}）`);
  const f2 = await J(`${BASE}/api/users/${vendorId}/memberships`, mgrTk2, { method: 'POST', body: JSON.stringify({ orgId: org2, role: 'reporter' }) });
  assert(f2.status === 404, `机构管理员 POST memberships → 404（实测 ${f2.status}）`);
  const f3 = await J(`${BASE}/api/users/${vendorId}/memberships/1`, mgrTk2, { method: 'DELETE' });
  assert(f3.status === 404, `机构管理员 DELETE membership → 404（实测 ${f3.status}）`);
  const f4 = await J(`${BASE}/api/users/${vendorId}/type`, mgrTk2, { method: 'PUT', body: JSON.stringify({ userType: 'hospital' }) });
  assert(f4.status === 404, `机构管理员 PUT type → 404（实测 ${f4.status}）`);

  // 跨机构不可见：在机构 2 建一个专属账号，机构 1 的管理员按 id 操作 → 404（不泄漏存在性）
  const mkOrg2User = await J(`${BASE}/api/users`, tk2, {
    method: 'POST', body: JSON.stringify({ username: 'org2admin', name: '中医院管理员', password: 'org212345', role: 'admin' }),
  });
  assert(mkOrg2User.status === 201 || mkOrg2User.status === 200, `在机构 2 新建专属账号 org2admin（HTTP ${mkOrg2User.status}）`);
  const x1 = await J(`${BASE}/api/users/${mkOrg2User.body.id}/type`, mgrTk2, { method: 'PUT', body: JSON.stringify({ userType: 'company' }) });
  assert(x1.status === 404, `机构 1 管理员改机构 2 专属账号的类型 → 404（实测 ${x1.status}）`);
  const x2 = await J(`${BASE}/api/users/${mkOrg2User.body.id}/memberships`, mgrTk2);
  assert(x2.status === 404, `机构 1 管理员读机构 2 专属账号的 memberships → 404（实测 ${x2.status}）`);

  // ===== 8. 用户类型变更进审计日志 =====
  const auditList = await J(`${BASE}/api/audit?action=UPDATE_USER_TYPE`, tk);
  const auditRows = (auditList.body && auditList.body.rows) || [];
  assert(auditList.status === 200 && auditRows.some((a) => a.action === 'UPDATE_USER_TYPE' && a.target === 'mgr1'),
    `用户类型变更写入审计日志（实测 ${auditRows.length} 条 UPDATE_USER_TYPE）`);
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
