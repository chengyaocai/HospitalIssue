// v1.18.31 专项测试：'kb' 菜单 key 的一次性存量迁移（perm_menus_migrated_v2）。
// 背景：normalizePermissions 对存量权限只过滤非法 key、不会新增菜单 key——老库所有角色的
// menus 都没有 'kb'，升级后「运维知识库」菜单不显示（多机构库的机构级设置同样缺）。
// 迁移与 v1.6 的 perm_menus_migrated_v1 同模式，但覆盖「全局 + 各机构」两路。
// 运行：node test/kb-menu-migrate.test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3322;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmpDb = path.join(os.tmpdir(), `issues-kbmig-${stamp}.json`);
const tmpUsers = path.join(os.tmpdir(), `users-kbmig-${stamp}.json`);
const tmpAudit = path.join(os.tmpdir(), `audit-kbmig-${stamp}.json`);
const tmpUploads = path.join(os.tmpdir(), `uploads-kbmig-${stamp}`);
const tmpSettings = path.join(os.tmpdir(), `settings-kbmig-${stamp}.json`);
const tmpNotifications = path.join(os.tmpdir(), `notifications-kbmig-${stamp}.json`);
const tmpChat = path.join(os.tmpdir(), `chat-kbmig-${stamp}.json`);
const tmpOrgs = path.join(os.tmpdir(), `orgs-kbmig-${stamp}.json`);
const tmpSchedules = path.join(os.tmpdir(), `schedules-kbmig-${stamp}.json`);

// —— 预写「v1.18.26 时代」的旧权限（所有角色 menus 均无 'kb'）——
const OLD_ROLES = JSON.stringify([
  { key: 'admin', label: '管理员', builtin: true },
  { key: 'reporter', label: '登记员', builtin: true },
]);
const OLD_PERMS = JSON.stringify({
  admin: { menus: ['dashboard', 'issues', 'audited', 'chat', 'users', 'audit', 'settings', 'schedule'] },
  reporter: { menus: ['dashboard', 'issues', 'audited', 'schedule', 'chat'] },
});
// 全局 + 默认机构 1 的机构级设置，均为旧数据（含 v1 标记：v1.6 迁移在旧版本已跑过）
fs.writeFileSync(tmpSettings, JSON.stringify({
  roles: OLD_ROLES,
  permissions: OLD_PERMS,
  perm_menus_migrated_v1: '1',
  __orgs: {
    1: { roles: OLD_ROLES, permissions: OLD_PERMS, perm_menus_migrated_v1: '1' },
  },
}, null, 2), 'utf8');

const env = {
  ...process.env,
  DB_DRIVER: 'dev',
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

try {
  await waitReady();

  // 1. 未登录 config：resolveOrgIdSoft 未登录回落**默认机构 1**（非 null）→ 触发**机构级**迁移。
  //    （全局 getSettings(null) 路径仅在升级首次请求 copyGlobalSettingsToOrg 时触发，
  //     与机构级共用同一段迁移代码，仅 orgId 参数不同。）
  const anon = await (await fetch(BASE + '/api/config')).json();
  const aMenus = anon.permissions?.admin?.menus || [];
  const rMenus = anon.permissions?.reporter?.menus || [];
  assert(Array.isArray(aMenus) && aMenus.includes('kb'), '机构级迁移（默认机构 1）：admin menus 补入 kb');
  assert(aMenus.includes('dashboard') && aMenus.includes('users') && aMenus.includes('schedule'),
    '机构级迁移：admin 原有菜单全部保留（无 kb 之外的内容丢失）');
  assert(rMenus.includes('kb'), '机构级迁移：reporter menus 补入 kb');

  // 2. 机构 1 的 v2 标记已写回文件；全局（根层）未被本次误改写
  const raw1 = JSON.parse(fs.readFileSync(tmpSettings, 'utf8'));
  assert(raw1.__orgs?.['1']?.perm_menus_migrated_v2 === '1', '机构 1 标记 perm_menus_migrated_v2=1 已持久化');
  assert(JSON.parse(raw1.__orgs?.['1']?.permissions || '{}').admin?.menus?.includes('kb'),
    '机构 1 permissions 落盘含 kb');
  assert(raw1.perm_menus_migrated_v2 === undefined,
    '全局侧未被误触发（根层无 v2 标记；HTTP 面不经过全局路径，全局迁移由升级首请触发、代码同段）');

  // 3. admin 登录（默认机构 1）→ config 幂等
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  TOKEN = login.token || '';
  assert(!!TOKEN, 'admin 登录');
  const me = await (await authFetch('/api/auth/me')).json();
  assert((me.orgs || []).length >= 1, 'admin 有机构成员关系');

  const cfg1 = await (await authFetch('/api/config')).json();
  const o1Menus = cfg1.permissions?.admin?.menus || [];
  assert(o1Menus.includes('kb'), '登录后 config 幂等：机构 1 admin menus 仍含 kb');

  // 4. 幂等 + 手动移除不回加：PUT settings 把 admin menus 去掉 kb → 不再被加回
  const put = await authFetch('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ permissions: { admin: { menus: ['dashboard', 'issues', 'users', 'audit', 'settings'] } } }),
  });
  assert(put.ok, `PUT settings 保存成功（${put.status}）`);
  const cfg2 = await (await authFetch('/api/config')).json();
  const a2 = cfg2.permissions?.admin?.menus || [];
  assert(!a2.includes('kb'), '管理员手动移除 kb 后不被迁移加回（标记已置，幂等）');
  assert(a2.includes('users') && a2.includes('settings'), '手动配置的其它菜单保留');

  // 5. 再次读取：幂等，配置稳定
  const anon2 = await (await fetch(BASE + '/api/config')).json();
  const aAnon2 = anon2.permissions?.admin?.menus || [];
  assert(!aAnon2.includes('kb') && aAnon2.includes('users'), '重复读取不重复迁移（手动移除的 kb 不回加、其它配置稳定）');
} catch (e) {
  failed++;
  console.error('  FAIL 测试执行异常:', e && e.message || e);
} finally {
  server.kill();
  console.log(`\n# kb-menu-migrate: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
