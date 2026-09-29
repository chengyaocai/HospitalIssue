import { config } from '../config.js';
import { createDevOrgStore } from './devOrgStore.js';
import { createMssqlOrgStore } from './mssqlOrgStore.js';
import { getUserStore } from '../auth/index.js';
import { copyGlobalSettingsToOrg } from '../settings/index.js';
import { BUILTIN_ROLES } from '../permissions.js';

let store;
let readyPromise = null;

// 平台管理员在任何机构所用的有效角色（恒定）。
// 必须是内置管理员角色：其 key 恒定存在（内置角色只可改名、不可删除），
// 且每个机构的设置里都必然有一份它的权限配置（默认全开），因此拿它一定能管该机构。
//
// 为什么不能回落「全局角色」：平台管理员通常只在自己医院有成员关系，
// 而他的全局角色（app_user.role）多半只是「登记员」—— 一旦按它取权限，
// 切到别家机构后 users / settings 菜单会直接消失、接口全 403，
// 出现「平台管理员在别的机构里什么都管不了」的矛盾。见 v1.18.3。
export const PLATFORM_ADMIN_ROLE = (BUILTIN_ROLES.find((r) => r.key === 'admin') || {}).key || 'admin';

// 是否「按机构固定为管理员」的角色（供路由层与界面判断：这类成员的角色不可也不必按机构调整）
export function isFixedAdminRole(user) {
  return !!user && user.platformAdmin === true;
}

export async function getOrgStore() {
  if (store) return store;
  store = config.dbDriver === 'dev'
    ? createDevOrgStore(config.orgsDevPath)
    : createMssqlOrgStore(config.mssql);
  return store;
}

// 幂等初始化（首次被请求触发时惰性执行——不在启动时连库，保持「库挂了服务也能起」的特性）：
//  1) 保证存在至少一个机构（默认机构），单机构部署下即为唯一机构，行为与升级前一致；
//  2) 引导平台管理员：若系统内尚无任何平台管理员，把最早的一个 admin 角色用户提升为平台管理员
//     （升级场景下老库 is_platform_admin 一律为 0，不引导会导致「无人能管理多机构」）；
//  3) 把全局系统设置一次性复制为该机构的机构级设置（已有机构级设置则不覆盖）；
//  4) 把尚未归属任何机构的用户补进默认机构（沿用其全局角色）。
export async function ensureOrgs() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const s = await getOrgStore();
    let def = (await s.list())[0] || null;
    if (!def) def = await s.create({ code: 'default', name: config.defaultOrgName });

    const us = await getUserStore();
    const users = await us.list();
    if (!users.some((u) => u.platformAdmin) && typeof us.setPlatformAdmin === 'function') {
      const admin = users
        .filter((u) => u.role === 'admin')
        .sort((a, b) => Number(a.id) - Number(b.id))[0];
      if (admin) await us.setPlatformAdmin(admin.id, true);
    }

    const known = new Set((await s.allMembers()).map((m) => String(m.user_id)));
    for (const u of users) {
      if (!known.has(String(u.id))) await s.setMember(u.id, def.id, u.role || 'reporter');
    }

    await copyGlobalSettingsToOrg(def.id);
    return def;
  })();
  return readyPromise;
}

// 默认机构 id（单机构部署下的唯一机构）。
export async function defaultOrgId() {
  return (await ensureOrgs()).id;
}

// 用户在某机构内的有效角色。判定顺序（v1.18.10 起）：
//   1) **平台管理员 → 内置管理员角色（在全部机构恒定）**；
//   2) 有成员关系 → 成员关系里的角色；
//   3) 都没有     → 回落其全局角色（兼容升级前的单机构行为）。
//
// 【为什么平台管理员要排在「成员关系」之前（v1.18.10 修正 v1.18.3 的遗留漏洞）】
// v1.18 升级时 ensureOrgs() 会把用户的「全局角色」复制成默认机构的**成员角色**，
// 而平台管理员的全局角色往往只是「登记员」—— 于是他在**自己的医院**里被这个
// 自动生成的成员角色降权：审核通过 / 用户管理 / 系统设置三个菜单直接消失
// （实测 /api/auth/me 返回 user.role='reporter' 同时 platformAdmin=true，看起来自相矛盾）。
// 这既违背 v1.18.3 已确立的原则（**平台管理员的权限不该由他的全局角色决定**），
// 也不是有效的安全边界 —— 平台管理员本来就能在任意机构把自己或别人改成管理员
// （机构管理 → 成员管理），限制他等于只制造困惑、不产生约束。
//
// 影响范围：非平台管理员**完全不变**（成员关系优先的原则依然成立，
// 「故意给某个普通成员配一个低权限角色」照样生效）。单机构部署下，
// 启动引导只会把「最早的 admin 角色用户」提升为平台管理员，其成员角色本来就是 admin，
// 因此界面零变化。
export async function roleInOrg(userId, orgId, fallbackRole, isPlatformAdmin = false) {
  if (isPlatformAdmin) return PLATFORM_ADMIN_ROLE;
  const s = await getOrgStore();
  const rows = await s.orgsOf(userId);
  const m = rows.find((x) => String(x.org_id) === String(orgId));
  if (m && m.role) return m.role;                    // 成员关系优先（被显式配了别的角色也尊重）
  return fallbackRole || 'reporter';
}

// 用户可访问的机构列表（含其在各机构内的角色）。单机构部署下永远只返回默认机构一条。
// isPlatformAdmin=true 时返回全部机构（平台管理员可跨机构切换）。
// 注意：平台管理员的 role 在**每个**机构都报内置管理员角色 —— 与 roleInOrg 保持一致，
// 否则切换器/界面会显示一个与真实生效权限不符的角色。
export async function orgsForUser(userId, fallbackRole, isPlatformAdmin = false) {
  const s = await getOrgStore();
  const def = await ensureOrgs();
  const all = await s.list();
  const mine = await s.orgsOf(userId);
  const roleOf = new Map(mine.map((m) => [String(m.org_id), m.role]));
  const out = [];
  for (const o of all) {
    const key = String(o.id);
    const member = roleOf.has(key);
    if (!isPlatformAdmin && !member) {
      // 非平台管理员：仅可见自己有成员关系的机构；完全没有成员关系时兜底给默认机构（保证老账号可用）。
      if (mine.length > 0 || o.id !== def.id) continue;
    }
    out.push({
      id: o.id,
      code: o.code,
      name: o.name,
      active: o.active,
      role: isPlatformAdmin ? PLATFORM_ADMIN_ROLE : (roleOf.get(key) || fallbackRole || 'reporter'),
    });
  }
  return out;
}

// 某机构的成员（附用户信息与**生效**机构内角色）。
// 用于：机构内用户列表（用户管理花名册 / 机构管理成员列表）、通知接收范围校验、全员广播对象。
//
// 角色字段的语义（v1.18.10）：
//   - `role`      = **生效角色**。平台管理员一律为内置管理员角色（与 roleInOrg 一致）；
//   - `storedRole`= 成员关系里**实际存的**角色（可能被平台管理员规则覆盖）；
//   - `roleFixed` = true 表示该成员的机构内角色**不可也不必调整**（平台管理员），
//                   界面据此把角色下拉换成说明文字 —— 否则用户改了不生效，会以为控件坏了。
export async function membersWithUser(orgId) {
  const s = await getOrgStore();
  const members = await s.membersOf(orgId);
  const users = await (await getUserStore()).list();
  const byId = new Map(users.map((u) => [String(u.id), u]));
  const out = [];
  for (const m of members) {
    const u = byId.get(String(m.user_id));
    if (!u) continue;   // 账号已被彻底清除：跳过（保留成员关系以便审计）
    const fixed = isFixedAdminRole(u);
    out.push({
      ...u,
      role: fixed ? PLATFORM_ADMIN_ROLE : (m.role || u.role),
      storedRole: m.role || u.role,
      roleFixed: fixed,
    });
  }
  return out;
}

// —— 以下为带业务守卫的机构维护操作（供路由层直接调用）——

export async function listOrgs() {
  const s = await getOrgStore();
  const orgs = await s.list();
  const counts = await Promise.all(orgs.map((o) => s.memberCount(o.id)));
  return orgs.map((o, i) => ({ ...o, memberCount: counts[i] }));
}

export async function createOrg({ code, name, creatorId }) {
  const s = await getOrgStore();
  await ensureOrgs();
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName) {
    const err = new Error('请填写机构名称');
    err.status = 400;
    throw err;
  }
  const cleanCode = String(code || '').trim().slice(0, 50);
  const created = await s.create({ code: cleanCode || undefined, name: cleanName });
  if (!created) {
    const err = new Error('机构编码已存在，请更换后重试');
    err.status = 400;
    throw err;
  }
  // 创建者自动成为该机构成员（管理员角色）。
  // 否则新机构会以「0 成员」开局：成员列表一片空白、通知广播无人接收、
  // 界面还会出现「刚建好的机构自己却管不了」，且与「不能移出该机构最后一个成员」的守卫自相矛盾。
  if (creatorId != null) await s.setMember(creatorId, created.id, PLATFORM_ADMIN_ROLE);
  return created;
}

export async function updateOrg(id, patch = {}) {
  const s = await getOrgStore();
  await ensureOrgs();
  const cur = await s.get(id);
  if (!cur) {
    const err = new Error('机构不存在或已被删除');
    err.status = 404;
    throw err;
  }
  const next = {};
  if (typeof patch.name === 'string') next.name = patch.name;
  if (typeof patch.active === 'boolean') next.active = patch.active;
  // 守卫：不允许停用/删除最后一个「启用中」的机构，否则全系统无处可去。
  if (patch.active === false) {
    const orgs = await s.list();
    const activeOthers = orgs.filter((o) => o.id !== cur.id && o.active).length;
    if (activeOthers === 0) {
      const err = new Error('至少需要保留一个启用中的机构');
      err.status = 400;
      throw err;
    }
  }
  return s.update(id, next);
}

export async function removeOrg(id) {
  const s = await getOrgStore();
  await ensureOrgs();
  const cur = await s.get(id);
  if (!cur) {
    const err = new Error('机构不存在或已被删除');
    err.status = 404;
    throw err;
  }
  if ((await s.count()) <= 1) {
    const err = new Error('至少需要保留一个机构，无法删除');
    err.status = 400;
    throw err;
  }
  // 守卫：默认机构（id 最小者）不可删除，避免历史数据无处归属。
  const def = (await s.list())[0];
  if (def && String(def.id) === String(id)) {
    const err = new Error('默认机构不可删除，请先调整数据归属');
    err.status = 400;
    throw err;
  }
  await s.remove(id);
  return true;
}

// 设置某用户在某机构内的角色（同时建立成员关系）。
//
// v1.18.10：目标是**平台管理员**时，一律落库为管理员角色。
// 因为平台管理员在全部机构恒定按管理员生效（见 roleInOrg），若这里存了别的角色，
// 库里就会留下一个「永远不生效的角色」—— 成员列表看着是登记员、实际按管理员生效，
// 自相矛盾且极难排查。返回值带上 `coerced`，让界面能如实告知「已按平台管理员规则改为管理员」。
export async function setMemberRole(userId, orgId, role) {
  const s = await getOrgStore();
  await ensureOrgs();
  if (!(await s.get(orgId))) {
    const err = new Error('目标机构不存在');
    err.status = 404;
    throw err;
  }
  const target = await (await getUserStore()).findById(userId);
  const finalRole = isFixedAdminRole(target) ? PLATFORM_ADMIN_ROLE : role;
  await s.setMember(userId, orgId, finalRole);
  return { role: finalRole, coerced: finalRole !== role };
}

export async function removeMember(userId, orgId) {
  const s = await getOrgStore();
  await ensureOrgs();
  return s.removeMember(userId, orgId);
}
