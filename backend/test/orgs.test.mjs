// 数据层自检：多机构（v1.18）机构 / 成员关系 / 机构级设置 + 幂等迁移 + 守卫。
// 特点：dev 驱动、不连库、不起 HTTP 服务，直接调用 src 模块 —— 用于覆盖「默认机构不可删」
// 「最后一个启用机构不可停用」「机构级设置与全局设置相互隔离」这类难以用 HTTP 用例表达的数据层守卫。
// 运行：node test/orgs.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `org-test-${n}-${stamp}.json`);
// 必须在 import src 之前设置：config.js 在模块加载时读取环境变量。
process.env.DB_DRIVER = 'dev';
process.env.ORGS_DEV_PATH = tmp('orgs');
process.env.SETTINGS_DEV_PATH = tmp('settings');
process.env.DEV_USERS_PATH = tmp('users');
process.env.AUDIT_DEV_PATH = tmp('audit');
process.env.NOTIFICATIONS_DEV_PATH = tmp('notif');
process.env.CHAT_DEV_PATH = tmp('chat');
process.env.SCHEDULE_DEV_PATH = tmp('sched');
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.JWT_SECRET = 'org-test-secret';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.error('  FAIL', msg); }
}
async function expectReject(fn, msg) {
  try { await fn(); ok(false, msg); }
  catch (e) { ok(e.status === 400 || e.status === 404, `${msg}（${e.message}）`); }
}

const orgs = await import('../src/orgs/index.js');
const settings = await import('../src/settings/index.js');
const { getUserStore } = await import('../src/auth/index.js');
const { config } = await import('../src/config.js');

// —— 1. 首次引导：默认机构 + 平台管理员 + 成员补齐 ——
const def = await orgs.ensureOrgs();
ok(!!def && def.id === 1, '首次引导创建默认机构，id=1');
ok(def.name === config.defaultOrgName, `默认机构名称 = ${config.defaultOrgName}`);
const users = await (await getUserStore()).list();
const admin = users.find((u) => u.username === 'admin');
ok(!!admin && admin.platformAdmin === true, '内置 admin 被引导为平台管理员');
const memberCount1 = await (await orgs.getOrgStore()).memberCount(1);
ok(memberCount1 === users.length, `全部 ${users.length} 个用户已补进默认机构`);

// —— 2. 幂等：重复调用不重复建机构 / 不重复建成员 ——
const def2 = await orgs.ensureOrgs();
ok(def2.id === 1 && (await (await orgs.getOrgStore()).memberCount(1)) === memberCount1, 'ensureOrgs 幂等（不重复建机构/成员）');

// —— 3. 平台管理员可见全部机构；普通视角仅见自己有归属的机构 ——
const created = await orgs.createOrg({ name: '海盐县中医院' });
ok(created.id === 2 && created.code === 'org2', 'createOrg 生成 id=2 且 code 自动回填 org2');
ok((await orgs.orgsForUser(admin.id, admin.role, true)).length === 2, '平台管理员可见全部 2 个机构');
ok((await orgs.orgsForUser(admin.id, admin.role, false)).length === 1, '非平台视角：仅见已归属的默认机构');

// —— 4. 成员关系 / 机构内角色 ——
await orgs.setMemberRole(admin.id, 2, 'admin');
ok((await orgs.orgsForUser(admin.id, admin.role, false)).length === 2, '加入成员关系后可见机构数变为 2');
ok((await orgs.roleInOrg(admin.id, 2, admin.role)) === 'admin', 'roleInOrg 取到机构内角色');
ok((await orgs.roleInOrg(999, 1, 'reporter')) === 'reporter', 'roleInOrg 无成员关系时回落全局角色');

// —— 4b. v1.18.3：平台管理员在「无成员关系的机构」按管理员生效；创建者自动入机构 ——
// 修复前：角色回落「全局角色」，而平台管理员的全局角色多为登记员 ->
// 切到别家机构后 users / settings 菜单消失、接口全 403。
ok((await orgs.roleInOrg(999, 1, 'reporter', true)) === 'admin',
  '平台管理员无成员关系时按管理员生效（不回落到全局角色 reporter）');
ok((await orgs.roleInOrg(999, 1, 'reporter', false)) === 'reporter',
  '非平台管理员无成员关系时仍回落全局角色（兼容升级前单机构行为）');
ok((await orgs.orgsForUser(999, 'reporter', true)).every((o) => o.role === 'admin'),
  '平台管理员的 orgsForUser 列表里各机构角色均为管理员');
const withCreator = await orgs.createOrg({ name: '创建者入机构验证', creatorId: admin.id });
ok(withCreator.id === 3, 'createOrg 带 creatorId 时生成 id=3');
const wcMembers = await (await orgs.getOrgStore()).membersOf(withCreator.id);
ok(wcMembers.some((m) => String(m.user_id) === String(admin.id) && m.role === 'admin'),
  '创建者自动成为新机构成员（管理员角色）');
ok((await (await orgs.getOrgStore()).memberCount(withCreator.id)) === 1, '新机构以 1 名成员（创建者）开局，不再是 0 成员');
ok((await orgs.removeOrg(withCreator.id)) === true, '（清理）删除创建者验证机构');

// —— 4c. v1.18.10：平台管理员在「有成员关系的机构」里同样按管理员生效 ——
// 修复前的漏洞：roleInOrg 是「成员关系优先」，而 v1.18 升级时 ensureOrgs() 会把用户的
// **全局角色**复制成默认机构的成员角色；平台管理员的全局角色往往只是「登记员」
// -> 于是他在**自己的医院**里被降权：审核通过 / 用户管理 / 系统设置 三个菜单消失。
// 实测复现（探针，公开 API）：把 admin 在机构 1 的成员角色设为 reporter 后，
// /api/auth/me 返回 user.role='reporter' 同时 platformAdmin=true —— 自相矛盾。
// 绕过 setMemberRole 的守卫，直接把成员角色写成 reporter —— 模拟「库里已存的升级遗留数据」
await (await orgs.getOrgStore()).setMember(admin.id, 1, 'reporter');
// 有效角色：平台管理员优先于成员关系
ok((await orgs.roleInOrg(admin.id, 1, 'reporter', true)) === 'admin',
  '平台管理员即使在本机构有成员关系，也按管理员生效（v1.18.10 修正「自己被自己医院降权」）');
ok((await orgs.orgsForUser(admin.id, 'reporter', true)).every((o) => o.role === 'admin'),
  '平台管理员的 orgsForUser 在全部机构都报管理员角色（与 roleInOrg 一致）');
// 成员名册：role 是「生效角色」，storedRole 保留库里实际存的值，roleFixed 供界面锁定控件
const roster1 = await orgs.membersWithUser(1);
const adminRow = roster1.find((u) => String(u.id) === String(admin.id));
ok(adminRow && adminRow.role === 'admin' && adminRow.roleFixed === true,
  'membersWithUser 对平台管理员返回生效角色 admin 且标记 roleFixed');
ok(adminRow && adminRow.storedRole === 'reporter',
  `membersWithUser 同时保留库里实存角色（storedRole=${adminRow && adminRow.storedRole}，供界面说明与排查）`);
// 写路径：setMemberRole 对平台管理员落库即纠正，不留下「永不生效的角色」
const coerced = await orgs.setMemberRole(admin.id, 1, 'reporter');
ok(coerced.role === 'admin' && coerced.coerced === true,
  'setMemberRole 对平台管理员强制写管理员并回报 coerced=true（不静默存无效角色）');
ok(((await (await orgs.getOrgStore()).membersOf(1)).find((m) => String(m.user_id) === String(admin.id)) || {}).role === 'admin',
  '落库后的成员角色确为 admin（库里不再存在与生效角色不符的值）');

// 非平台管理员：**成员关系优先的原则完全不变**（故意给他配低权限角色照样生效）
const us1 = await getUserStore();
const plain = await us1.create({ username: 'plain_reporter', name: '普通登记员', role: 'reporter', password: 'dummy-not-used' });
await orgs.setMemberRole(plain.id, 1, 'reporter');
ok((await orgs.roleInOrg(plain.id, 1, 'admin', false)) === 'reporter',
  '非平台管理员仍以成员关系里的角色为准（这里主动回落值给 admin，结果仍是 reporter）');
ok((await orgs.setMemberRole(plain.id, 1, 'admin')).coerced === false, '非平台管理员改角色不会被 coerced');
const plainRow = (await orgs.membersWithUser(1)).find((u) => String(u.id) === String(plain.id));
ok(plainRow && plainRow.role === 'admin' && plainRow.roleFixed === false,
  '非平台管理员的成员角色按其实际配置生效，且不标记 roleFixed');

// —— 5. 机构级设置与全局设置相互隔离（升级时默认机构继承全局配置）——
const globalBefore = await settings.getSettings();
const orgBefore = await settings.getSettings(1);
ok(orgBefore.roles.length === globalBefore.roles.length, '机构级设置已从全局继承（roles 一致）');
await settings.updateSettings({ appName: '机构一专属名称' }, 1);
ok((await settings.getSettings(1)).appName === '机构一专属名称', '机构级 appName 写入成功');
ok((await settings.getSettings()).appName === globalBefore.appName, '写机构级设置不影响全局设置');
ok(globalBefore.permissions && Object.keys(globalBefore.permissions).length > 0, '全局权限矩阵仍可正常读取');

// —— 6. 守卫：最后一个启用机构不可停用、默认机构不可删 ——
const deactivated = await orgs.updateOrg(2, { active: false });
ok(deactivated.active === false, '停用非最后一个机构成功');
await expectReject(() => orgs.updateOrg(1, { active: false }), '停用最后一个启用机构被拒');
ok((await orgs.updateOrg(2, { active: true })).active === true, '重新启用机构成功');
await expectReject(() => orgs.removeOrg(1), '删除默认机构被拒');
ok((await orgs.removeOrg(2)) === true, '删除非默认机构成功');
ok((await orgs.listOrgs()).length === 1, '删除后仅剩 1 个机构');
await expectReject(() => orgs.removeOrg(1), '仅剩一个机构时删除被拒');
await expectReject(() => orgs.createOrg({ name: '   ' }), '空机构名被拒 400');

// —— 7. 持久化落盘 ——
const rawOrgs = JSON.parse(fs.readFileSync(process.env.ORGS_DEV_PATH, 'utf8'));
ok(rawOrgs.orgs.length === 1 && rawOrgs.orgs[0].name === config.defaultOrgName, '机构数据已落盘');
const rawSet = JSON.parse(fs.readFileSync(process.env.SETTINGS_DEV_PATH, 'utf8'));
ok(rawSet.__orgs && rawSet.__orgs['1'] && rawSet.__orgs['1'].appName === '机构一专属名称', '机构级设置落盘于 __orgs[1]');

for (const f of [
  process.env.ORGS_DEV_PATH, process.env.SETTINGS_DEV_PATH, process.env.DEV_USERS_PATH,
  process.env.AUDIT_DEV_PATH, process.env.NOTIFICATIONS_DEV_PATH, process.env.CHAT_DEV_PATH, process.env.SCHEDULE_DEV_PATH,
]) {
  try { fs.unlinkSync(f); } catch { /* 忽略清理失败 */ }
}

console.log(`\nRESULT: passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
