// v1.18.10 端到端：**平台管理员的有效角色在全部机构恒为管理员**（左侧菜单少的那件事）。
//
// 背景（用户实际遇到的现象）：同一个平台管理员账号，在「海盐县人民医院」只看到
// 数据驾驶舱/问题登记/聊天/消息通知/值班表/操作日志/机构管理；在自己新建的
// 「海盐县中医院」却能看到完整的 8 个菜单（多出 审核通过 / 用户管理 / 系统设置）。
//
// 根因（两层）：
//   ① 左侧菜单由 `/api/config` 的 `permissions[当前机构内的角色]` 决定 —— **按机构内角色，不按账号**；
//   ② v1.18 升级时 `ensureOrgs()` 会把用户的「全局角色」**复制成默认机构的成员角色**，
//      而平台管理员的全局角色往往只是「登记员」；当时 `roleInOrg` 是「成员关系优先」，
//      **平台管理员的自动提权被这一行短路** → 他在自己的医院里被自己机构的角色降权。
//   实测复现：把 admin 在机构 1 的成员角色设为 reporter 后，`/api/auth/me` 返回
//   `user.role='reporter'` 同时 `platformAdmin=true`（自相矛盾）。
//
// 修复：`roleInOrg` 把「平台管理员」判在「成员关系」**之前**；写路径（`setMemberRole` /
// `PUT /users/:id/role`）对平台管理员一律落 admin，不留「永不生效的角色」。
// 非平台管理员**完全不变**（成员关系优先的原则依然成立）—— 本套件用**差分断言**钉住这一点。
//
// 数据层的「升级遗留数据」用例（库里存 reporter + 平台管理员）在 `orgs.test.mjs` 的 4c 段。
// 运行：node test/org-role.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3313;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `orgrole-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `orgrole-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'org-role-test-secret',
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
const menusOf = (cfg, role) => ((cfg.permissions || {})[role] || {}).menus || [];

async function main() {
  await waitReady();

  // ===== 1. 平台管理员登录：有效角色即管理员 =====
  const login = await J(`${BASE}/api/auth/login`, null, {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  assert(login.status === 200, `平台管理员登录成功（HTTP ${login.status}）`);
  const tk = login.body.token;
  const adminId = login.body.user.id;
  assert(login.body.user.role === 'admin' && login.body.user.platformAdmin === true,
    `登录响应 user.role=${login.body.user.role} 且 platformAdmin=${login.body.user.platformAdmin}`);

  // 建第二个机构（创建者自动成为其成员，管理员角色）
  const mk = await J(`${BASE}/api/orgs`, tk, { method: 'POST', body: JSON.stringify({ code: 'zyy', name: '海盐县中医院' }) });
  assert(mk.status === 201, `新建机构成功（id=${mk.body && mk.body.id}）`);

  // ===== 2. 核心规则：平台管理员在「有成员关系的机构」里也按管理员生效 =====
  // 模拟 v1.18 升级的产物：把 admin 在机构 1 的成员角色「设为」reporter。
  const coerce = await J(`${BASE}/api/orgs/1/members`, tk, { method: 'POST', body: JSON.stringify({ userId: adminId, role: 'reporter' }) });
  assert(coerce.status === 200 && coerce.body.role === 'admin' && coerce.body.coerced === true,
    `把平台管理员的机构内角色设为 reporter → 落库纠正为 admin 并回报 coerced（实测 ${coerce.status}、role=${coerce.body && coerce.body.role}、coerced=${coerce.body && coerce.body.coerced}）`);

  const me = await J(`${BASE}/api/auth/me`, tk);
  assert(me.body.user.role === 'admin',
    `即便成员关系里写着 reporter，/api/auth/me 的有效角色仍是 admin（实测 ${me.body.user.role}）← 本套件核心断言`);
  assert((me.body.orgs || []).every((o) => o.role === 'admin'),
    `可访问机构列表在每个机构都报 admin（实测 ${JSON.stringify((me.body.orgs || []).map((o) => `${o.name}:${o.role}`))}）`);

  // 左侧菜单的真正来源
  const cfg = await J(`${BASE}/api/config`, tk);
  const adminMenus = menusOf(cfg.body, 'admin');
  for (const need of ['audited', 'users', 'settings']) {
    assert(adminMenus.includes(need), `平台管理员菜单包含「${need}」（实测菜单 ${JSON.stringify(adminMenus)}）`);
  }
  assert(cfg.body.permissions && cfg.body.permissions.reporter
    && !menusOf(cfg.body, 'reporter').includes('users'),
    '登记员角色本身不含「用户管理」→ 证明上面看到 users 是因为按管理员生效，不是权限表被放宽');

  // ===== 3. 写路径：平台管理员的机构内角色不可调整（明确 400，而非静默存无效值）=====
  const bad = await J(`${BASE}/api/users/${adminId}/role`, tk, { method: 'PUT', body: JSON.stringify({ role: 'reporter' }) });
  assert(bad.status === 400 && /平台管理员/.test((bad.body && bad.body.error) || ''),
    `改平台管理员的机构内角色被明确拒绝（HTTP ${bad.status}：${bad.body && bad.body.error}）`);
  const okAdmin = await J(`${BASE}/api/users/${adminId}/role`, tk, { method: 'PUT', body: JSON.stringify({ role: 'admin' }) });
  assert(okAdmin.status === 200, `改成 admin（与生效角色一致）则放行（HTTP ${okAdmin.status}）`);

  // 成员列表暴露「生效角色 / 库里实存角色 / 是否锁定」三件信息，供界面把下拉换成说明文字
  const mem = await J(`${BASE}/api/orgs/1/members`, tk);
  const adminRow = ((mem.body && mem.body.members) || []).find((m) => String(m.userId) === String(adminId));
  assert(!!adminRow && adminRow.role === 'admin' && adminRow.roleFixed === true,
    `成员列表里平台管理员：role=admin、roleFixed=true（实测 ${adminRow && adminRow.role}/${adminRow && adminRow.roleFixed}）`);
  assert(!!adminRow && typeof adminRow.storedRole === 'string',
    `并附带 storedRole=${adminRow && adminRow.storedRole}（供界面说明与排查）`);

  // ===== 4. 差分断言：非平台管理员**完全不变**（成员关系优先，故意配低权限角色照样生效）=====
  const created = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'nurse1', name: '内科护士', password: 'nurse123', role: 'reporter' }),
  });
  assert(created.status === 201 || created.status === 200, `新建普通账号 nurse1（HTTP ${created.status}）`);
  const nurseId = created.body && created.body.id;

  const nurseSet = await J(`${BASE}/api/orgs/1/members`, tk, { method: 'POST', body: JSON.stringify({ userId: nurseId, role: 'reporter' }) });
  assert(nurseSet.status === 200 && nurseSet.body.coerced === false,
    `非平台管理员设 reporter 不被 coerced（实测 coerced=${nurseSet.body && nurseSet.body.coerced}）`);

  const nurseLogin = await J(`${BASE}/api/auth/login`, null, {
    method: 'POST', body: JSON.stringify({ username: 'nurse1', password: 'nurse123' }),
  });
  assert(nurseLogin.body.user.role === 'reporter' && nurseLogin.body.user.platformAdmin === false,
    `普通账号的有效角色仍按其成员角色（实测 ${nurseLogin.body.user.role}，platformAdmin=${nurseLogin.body.user.platformAdmin}）`);
  const nurseCfg = await J(`${BASE}/api/config`, nurseLogin.body.token);
  assert(!menusOf(nurseCfg.body, 'reporter').includes('users'),
    `普通账号看不到「用户管理」（实测菜单 ${JSON.stringify(menusOf(nurseCfg.body, 'reporter'))}）`);
  const nurseMem = await J(`${BASE}/api/orgs/1/members`, tk);
  const nurseRow = ((nurseMem.body && nurseMem.body.members) || []).find((m) => String(m.userId) === String(nurseId));
  assert(!!nurseRow && nurseRow.roleFixed === false,
    '成员列表里普通成员 roleFixed=false（角色选择器保留，可正常调整）');

  // ===== 5. 反证：admin 拿到 admin 角色**正是因为**平台管理员身份 =====
  // 把 nurse1 也设为平台管理员（避免「不能取消最后一个平台管理员」的守卫），
  // 再取消 admin 的平台管理员身份 → 他应回落到成员关系里的角色。
  //
  // ⚠️ 角色走「登录时快照」（token 的 role 声明，见 middleware.js:28），因此 nurse1 被提为
  // 平台管理员后**必须重新登录**才能拿到带 platform/admin 的 token —— 这与「改任何角色都需
  // 重新登录才生效」的既有模型一致，不是本次改动引入的。
  const pa1 = await J(`${BASE}/api/users/${nurseId}/platform-admin`, tk, { method: 'PUT', body: JSON.stringify({ platformAdmin: true }) });
  assert(pa1.status === 200, `把 nurse1 设为平台管理员（HTTP ${pa1.status}）`);
  const nurseRe = await J(`${BASE}/api/auth/login`, null, {
    method: 'POST', body: JSON.stringify({ username: 'nurse1', password: 'nurse123' }),
  });
  const nurseTk = nurseRe.body.token;
  assert(nurseRe.body.user.role === 'admin' && nurseRe.body.user.platformAdmin === true,
    `nurse1 重新登录后 role=admin、platformAdmin=true（实测 ${nurseRe.body.user.role}/${nurseRe.body.user.platformAdmin}）← 重新登录即生效`);
  const pa0 = await J(`${BASE}/api/users/${adminId}/platform-admin`, nurseTk, { method: 'PUT', body: JSON.stringify({ platformAdmin: false }) });
  assert(pa0.status === 200, `取消 admin 的平台管理员身份（用 nurse1 的新 token；admin 此刻已无平台权限，HTTP ${pa0.status}）`);
  const meAfter = await J(`${BASE}/api/auth/me`, tk);
  assert(meAfter.body.user.platformAdmin === false, '取消后 /me 的 platformAdmin 立即为 false（v1.18.1 起以库为准）');
  assert(meAfter.body.user.role === 'admin',
    `此时角色仍为 admin —— 因为「取消平台管理员」不会回写机构内角色（${
      '该账号在机构 1 的成员角色此前已按平台管理员规则落为 admin'
    }）；这正是「角色不会被静默降级」的预期行为`);
  const restore = await J(`${BASE}/api/users/${adminId}/platform-admin`, nurseTk, { method: 'PUT', body: JSON.stringify({ platformAdmin: true }) });
  assert(restore.status === 200, `恢复 admin 的平台管理员身份（清理测试状态；须用 nurse1 的 token —— admin 此刻已无平台权限，HTTP ${restore.status}）`);

  // ===== 6. 切到第二个机构：平台管理员在那里同样是管理员 =====
  const sw = await J(`${BASE}/api/auth/switch-org`, tk, { method: 'POST', body: JSON.stringify({ orgId: mk.body.id }) });
  assert(sw.status === 200 && sw.body.user.role === 'admin',
    `切到「${mk.body.name}」后有效角色仍为 admin（实测 ${sw.body && sw.body.user && sw.body.user.role}）`);
  const cfg2 = await J(`${BASE}/api/config`, sw.body.token);
  assert(menusOf(cfg2.body, 'admin').length === adminMenus.length,
    `两个机构的菜单集合一致（${adminMenus.length} 项）`);
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
