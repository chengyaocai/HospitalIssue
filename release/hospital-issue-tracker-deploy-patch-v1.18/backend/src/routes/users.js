import express from 'express';
import { getUserStore } from '../auth/index.js';
import { hashPassword } from '../auth/password.js';
import { authenticate } from '../auth/middleware.js';
import { requirePermission, requirePlatformAdmin, isPlatformAdmin } from '../auth/authorize.js';
import { getSettings } from '../settings/index.js';
import { audit } from '../audit/index.js';
import { send500, sendError } from '../errors.js';
import { getOrgStore, membersWithUser, PLATFORM_ADMIN_ROLE, setMemberRole, removeMember } from '../orgs/index.js';
import { onlineUsernames, ONLINE_WINDOW_MS } from '../presence.js';

const router = express.Router();

// 联系电话脱敏（v1.18.17）：审计日志里不落明文电话，保留前 3 后 4（如 138****8026）。
// 过短的号码（≤7 位）全部打星，避免「前3后4」反而把整段号码原样泄漏。
function maskPhone(p) {
  if (!p) return '（空）';
  if (p.length <= 7) return '*'.repeat(p.length);
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

// 联系电话归一化（v1.18.17）：可选字段；trim 后最长 20 字符，超长由调用方决定报 400。
function normalizePhone(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

// 本机构的用户花名册（多机构 v1.18）：仅包含「归属当前机构」的成员，
// 角色取机构内的成员角色（无成员关系时回落其全局角色）。
// 单机构部署下（启动时已把所有存量用户补进默认机构）结果与升级前完全一致。
async function listOrgUsers(orgId) {
  return membersWithUser(orgId);
}

// 账号级操作（重置密码 / 停用启用）的机构边界守卫（v1.18.7）。返回可操作的账号对象；
// 已拒绝时直接写出响应并返回 null，调用方 `if (!target) return;` 即可。
//
// 【为什么不能只凭 user.manage】密码与启停状态都是**账号级、全局唯一**的（与该用户归属哪些
// 机构无关）。修复前这两个接口只检查 user.manage，于是甲机构的管理员可以按 id 重置 / 停用
// 一个「只属于乙机构」的账号 —— 跨机构接管他人账号。允许的只有两种情况：
//   1) 调用者是平台管理员：跨机构管理本就是其职责（且未改动他人账号时无需先切机构）；
//   2) 目标账号属于当前机构，且**不属于任何其它机构**（即「本机构专属账号」）。
// 单机构部署下所有用户都只属于默认机构，因此行为与升级前完全一致（无回归）。
// 拒绝时一律 404（与 PUT /:id/role、以及「跨机构按 id 读写一律 404」的约定一致），
// 不泄漏「该账号是否存在 / 是否属于别的机构」。
async function loadOwnableTarget(req, res) {
  const store = await getUserStore();
  const target = await store.findById(req.params.id);
  if (!target) { res.status(404).json({ error: '用户不存在' }); return null; }
  if (await isPlatformAdmin(req)) return target;
  const mine = String(req.orgId);
  const rows = await (await getOrgStore()).orgsOf(target.id);
  const isMine = rows.some((m) => String(m.org_id) === mine);
  const exclusive = rows.length > 0 && rows.every((m) => String(m.org_id) === mine);
  if (!isMine || !exclusive) { res.status(404).json({ error: '用户不存在' }); return null; }
  return target;
}

// 已登录用户均可查询「用户花名册」（仅返回 username / name），用于登记人下拉选择；
// 不含角色与密码等敏感信息，故不要求管理员权限。仅返回本机构成员。
// v1.18.29：加返回 userType（'hospital'|'company'，未知值归 hospital，与 usersMssql 映射语义一致），
// 供聊天「新建会话」选成员列表按类型分 sheet 页；userType 非敏感，可见范围与花名册本身一致。
router.get('/lookup', authenticate, async (req, res) => {
  try {
    const list = await listOrgUsers(req.orgId);
    res.json(list.map((u) => ({
      username: u.username,
      name: u.name || u.username,
      userType: u.userType === 'company' ? 'company' : 'hospital',
    })));
  } catch (e) {
    send500(res, e);
  }
});

// 在线状态（v1.18.41）：登录即可查询（不要求 user.manage —— 与 /lookup 同级的不敏感接口，
// 用户管理页面用，但聊天等场景以后也可复用）。返回「最近 90s 内有过认证请求」的账号名列表：
// 非平台管理员只含本机构成员（不泄漏跨机构账号名）；平台管理员返回全部（跨机构管理视角）。
router.get('/presence', authenticate, async (req, res) => {
  try {
    const online = onlineUsernames();
    if (req.user.platformAdmin) return res.json({ online, windowMs: ONLINE_WINDOW_MS });
    const members = await listOrgUsers(req.orgId);
    const mine = new Set(members.map((m) => m.username));
    return res.json({ online: online.filter((u) => mine.has(u)), windowMs: ONLINE_WINDOW_MS });
  } catch (e) {
    send500(res, e);
  }
});

// 仅具备「用户管理」功能权限的角色可管理用户
router.use(authenticate, requirePermission('user.manage'));

router.get('/', async (req, res) => {
  try {
    res.json(await listOrgUsers(req.orgId));
  } catch (e) {
    send500(res, e);
  }
});

router.post('/', async (req, res) => {
  try {
    const { username, name, password, role, userType } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
    if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    // 联系电话（v1.18.17）：可选；不传 / 空一律存空串，trim 后最长 20 字符。
    const phone = normalizePhone((req.body || {}).phone);
    if (phone.length > 20) return res.status(400).json({ error: '联系电话过长' });
    // 用户类型（v1.18.12）：可选，'hospital'（缺省）| 'company'。
    // 公司用户可归属多机构，属于跨机构能力 → 仅平台管理员可创建；非平台管理员传 company 一律 400。
    let type = 'hospital';
    if (userType !== undefined && userType !== null && userType !== '') {
      if (userType !== 'hospital' && userType !== 'company') return res.status(400).json({ error: '用户类型不合法' });
      if (userType === 'company' && !(await isPlatformAdmin(req))) {
        return res.status(400).json({ error: '仅平台管理员可创建公司用户' });
      }
      type = userType;
    }
    // 角色动态化：role 必须是「当前机构」系统设置里已存在的角色 key；
    // 未传时回落到 reporter（不存在则取第一个角色）。
    const settings = await getSettings(req.orgId);
    const roleKeys = settings.roles.map((r) => r.key);
    let r = role;
    if (r === undefined || r === null || r === '') {
      r = roleKeys.includes('reporter') ? 'reporter' : roleKeys[0];
    }
    if (!roleKeys.includes(r)) return res.status(400).json({ error: '角色不存在' });
    const store = await getUserStore();
    if (await store.findByUsername(username)) return res.status(409).json({ error: '用户名已存在' });
    const user = await store.create({ username, name: name || username, role: r, password: await hashPassword(password), userType: type, phone });
    // 同时把新账号加入当前机构（账号全局唯一，机构归属由成员关系表维护）。
    await (await getOrgStore()).setMember(user.id, req.orgId, r);
    await audit({ username: req.user.username, action: 'CREATE_USER', target: username, detail: `role=${r}${type === 'company' ? '；用户类型=公司' : ''}` });
    res.status(201).json(user);
  } catch (e) {
    send500(res, e);
  }
});

// 修改某用户在「当前机构」内的角色（角色动态化后可随时调整）。
router.put('/:id/role', async (req, res) => {
  try {
    const role = String((req.body && req.body.role) || '').trim();
    const settings = await getSettings(req.orgId);
    const roleKeys = settings.roles.map((r) => r.key);
    if (!roleKeys.includes(role)) return res.status(400).json({ error: '角色不存在' });
    const store = await getUserStore();
    const orgStore = await getOrgStore();
    const target = await store.findById(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });

    // 成员名单取「生效角色」（平台管理员一律为管理员，v1.18.10）——
    // 这同时让下面的「锁死保护」正确地把平台管理员算作具备管理权限的用户。
    const members = await listOrgUsers(req.orgId);
    const roleByUser = new Map(members.map((m) => [String(m.id), m.role]));
    // 只能修改「本机构成员」的角色：非本机构成员按 id 直接改一律 404
    // （与全局「跨机构按 id 读写返回 404」的约定一致，也避免把外部账号静默拉进本机构）。
    if (!roleByUser.has(String(target.id))) return res.status(404).json({ error: '用户不存在' });

    // v1.18.10：平台管理员在全部机构恒定按管理员生效，其机构内角色不可调整。
    // 直接 400（而不是静默存一个永远不生效的角色），把规则明确告诉调用方。
    if (target.platformAdmin === true && role !== PLATFORM_ADMIN_ROLE) {
      return res.status(400).json({
        error: `平台管理员在全部机构固定为管理员角色，无法改为「${role}」。如需限制其权限，请先取消其平台管理员身份。`,
      });
    }

    const oldRole = roleByUser.get(String(target.id));
    if (oldRole === role) return res.json({ ok: true, role });

    // 锁死保护：若该用户是「当前机构内唯一一个角色具备 用户管理+修改系统设置 的启用中用户」，
    // 且新角色不具备该组合，则拒绝，避免把自己关在门外。
    const qualifies = (rk) => {
      const p = settings.permissions[rk];
      return !!(p && p.actions && p.actions['user.manage'] === true && p.actions['settings.edit'] === true);
    };
    if (target.active && qualifies(oldRole) && !qualifies(role)) {
      const list = await listOrgUsers(req.orgId);
      const activePrivileged = list.filter((u) => u.active !== false && qualifies(u.role));
      const isLast = activePrivileged.length <= 1
        && activePrivileged.some((u) => String(u.id) === String(target.id));
      if (isLast) {
        return res.status(400).json({ error: '不能移除最后一个具备用户管理/修改系统设置权限的用户' });
      }
    }

    // 只写「本机构内的角色」。**绝不回写 app_user.role（全局角色）** ——
    // 全局角色会被「无成员关系机构」的角色回落逻辑读到，回写等于把本机构的改动泄漏到其它机构。
    await orgStore.setMember(target.id, req.orgId, role);
    await audit({
      username: req.user.username,
      action: 'UPDATE_USER_ROLE',
      target: target.username,
      detail: `${oldRole} -> ${role}`,
    });
    res.json({ ok: true, role });
  } catch (e) {
    send500(res, e);
  }
});

// 重置某用户密码（仅限「平台管理员」或「本机构专属账号」，见 loadOwnableTarget）
router.put('/:id/password', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    const target = await loadOwnableTarget(req, res);
    if (!target) return;
    await (await getUserStore()).setPassword(target.id, await hashPassword(password));
    await audit({ username: req.user.username, action: 'RESET_PASSWORD', target: target.username });
    res.json({ ok: true });
  } catch (e) {
    send500(res, e);
  }
});

// 修改某用户的联系电话（v1.18.17）。
// 电话与密码一样是**账号级、全局唯一**的字段，因此权限走同一条 loadOwnableTarget 边界：
//   - 平台管理员可改任意账号（含多机构公司用户）；
//   - 机构管理员仅限「仅属本机构」的账号；多机构公司用户 / 跨机构专属账号一律 404
//     （与重置密码一致，不泄漏账号存在性）。
// 审计详情记录旧→新，且**新电话脱敏**（保留前3后4），避免明文电话进操作日志。
router.put('/:id/phone', async (req, res) => {
  try {
    const phone = normalizePhone((req.body || {}).phone);
    if (phone.length > 20) return res.status(400).json({ error: '联系电话过长' });
    const target = await loadOwnableTarget(req, res);
    if (!target) return;
    const oldPhone = target.phone || '';
    if (oldPhone === phone) return res.json({ ok: true, phone, unchanged: true });
    await (await getUserStore()).setPhone(target.id, phone);
    await audit({
      username: req.user.username,
      action: 'UPDATE_USER_PHONE',
      target: target.username,
      detail: `联系电话 ${maskPhone(oldPhone)} -> ${maskPhone(phone)}`,
    });
    res.json({ ok: true, phone });
  } catch (e) {
    send500(res, e);
  }
});

// 指派 / 取消「平台管理员」（跨机构管理权限）。
// 额外要求调用者本人是平台管理员，避免组织内管理员自我提权；且不允许取消最后一个平台管理员。
router.put('/:id/platform-admin', requirePlatformAdmin(), async (req, res) => {
  try {
    const flag = req.body && req.body.platformAdmin === true;
    const store = await getUserStore();
    const target = await store.findById(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });

    if (!flag) {
      const users = await store.list();
      const admins = users.filter((u) => u.platformAdmin === true);
      const isLast = admins.length <= 1 && admins.some((u) => String(u.id) === String(target.id));
      if (isLast) return res.status(400).json({ error: '不能取消最后一个平台管理员' });
    }

    await store.setPlatformAdmin(target.id, flag);
    await audit({
      username: req.user.username,
      action: flag ? 'GRANT_PLATFORM_ADMIN' : 'REVOKE_PLATFORM_ADMIN',
      target: target.username,
    });
    res.json({ ok: true, platformAdmin: flag });
  } catch (e) {
    send500(res, e);
  }
});

// 停用 / 启用账号（账号状态全局生效，与该用户归属哪些机构无关；
// 因此同样只允许「平台管理员」或「本机构专属账号」，见 loadOwnableTarget）
router.put('/:id/status', async (req, res) => {
  try {
    const active = req.body?.active === true || req.body?.active === 'true';
    const target = await loadOwnableTarget(req, res);
    if (!target) return;
    if (!active && target.username === req.user.username) {
      return res.status(400).json({ error: '不能停用当前登录的账号' });
    }
    await (await getUserStore()).setActive(target.id, active);
    await audit({ username: req.user.username, action: active ? 'ENABLE_USER' : 'DISABLE_USER', target: target.username });
    res.json({ ok: true, active });
  } catch (e) {
    send500(res, e);
  }
});

// 改用户类型（v1.18.12）：'hospital'（院方，单机构）⇄ 'company'（公司，可归属多机构）。
// 仅平台管理员：非平台管理员一律 404（走 loadOwnableTarget 同款边界 —— 目标不可定位 /
// 属于别的机构 / 无权操作，统一「用户不存在」，不泄漏存在性）。
// 守卫：公司 → 院方时若仍归属多个机构，先移出多余机构（否则院方用户的「单机构」语义被破坏）。
router.put('/:id/type', async (req, res) => {
  try {
    if (!(await isPlatformAdmin(req))) return res.status(404).json({ error: '用户不存在' });
    const target = await loadOwnableTarget(req, res);
    if (!target) return;
    const nextType = req.body ? req.body.userType : undefined;
    if (nextType !== 'hospital' && nextType !== 'company') return res.status(400).json({ error: '用户类型不合法' });
    const oldType = target.userType === 'company' ? 'company' : 'hospital';
    if (nextType !== oldType && nextType === 'hospital') {
      const rows = await (await getOrgStore()).orgsOf(target.id);
      if (rows.length > 1) {
        return res.status(400).json({ error: `该公司用户仍属于 ${rows.length} 个机构，请先将其移出多余机构` });
      }
    }
    await (await getUserStore()).setUserType(target.id, nextType);
    await audit({
      username: req.user.username,
      action: 'UPDATE_USER_TYPE',
      target: target.username,
      detail: `${oldType === 'company' ? '公司' : '院方'} -> ${nextType === 'company' ? '公司' : '院方'}`,
    });
    res.json({ ok: true, userType: nextType });
  } catch (e) {
    send500(res, e);
  }
});

// —— 公司用户的多机构分配（v1.18.12，仅平台管理员）——
// 院方用户的机构归属维持既有模型（创建时进当前机构、跨机构加入走「机构管理」由平台管理员专办）；
// 公司用户则打破「账号专属单一机构」的隐含假设，允许同时归属多个机构（各机构内角色独立）。

// 某用户的全部机构成员关系（附机构名与启用状态）。
router.get('/:id/memberships', async (req, res) => {
  try {
    if (!(await isPlatformAdmin(req))) return res.status(404).json({ error: '用户不存在' });
    const target = await (await getUserStore()).findById(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    const orgStore = await getOrgStore();
    const rows = await orgStore.orgsOf(target.id);
    const out = [];
    for (const m of rows) {
      const o = await orgStore.get(m.org_id);
      out.push({
        orgId: o ? o.id : m.org_id,
        orgName: o ? o.name : '',
        role: m.role || '',
        orgActive: o ? o.active !== false : false,
      });
    }
    res.json(out);
  } catch (e) {
    send500(res, e);
  }
});

// 把用户加入某机构（或幂等更新其在该机构内的角色）。仅公司用户。
router.post('/:id/memberships', async (req, res) => {
  try {
    if (!(await isPlatformAdmin(req))) return res.status(404).json({ error: '用户不存在' });
    const target = await (await getUserStore()).findById(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if ((target.userType || 'hospital') !== 'company') {
      return res.status(400).json({ error: '院方用户只能属于一个机构，如需加入多机构请先改为公司用户' });
    }
    const orgId = req.body ? req.body.orgId : undefined;
    const role = String((req.body && req.body.role) || '').trim();
    if (orgId === undefined || orgId === null || orgId === '') return res.status(400).json({ error: '请选择要加入的机构' });
    if (!role) return res.status(400).json({ error: '请选择角色' });

    const orgStore = await getOrgStore();
    const org = await orgStore.get(orgId);
    if (!org) return res.status(404).json({ error: '机构不存在或已被删除' });
    if (!org.active) return res.status(400).json({ error: '该机构已停用，无法加入' });
    const settings = await getSettings(org.id);
    if (!settings.roles.some((r) => r.key === role)) return res.status(400).json({ error: '角色不存在' });

    // setMember 为幂等 upsert：重复加入同一机构只会更新其机构内角色。
    const { role: finalRole, coerced } = await setMemberRole(target.id, org.id, role);
    await audit({
      username: req.user.username,
      action: 'ASSIGN_USER_ORG',
      target: target.username,
      detail: `加入机构「${org.name}」，角色设为 ${finalRole}${coerced ? `（平台管理员固定为 ${PLATFORM_ADMIN_ROLE}，原选择 ${role} 未生效）` : ''}`,
    });
    res.json({ ok: true, orgId: org.id, role: finalRole, coerced });
  } catch (e) {
    sendError(res, e);
  }
});

// 把用户移出某机构。守卫：用户至少保留一个机构；机构至少保留一个成员（与「机构管理」的既有守卫一致）。
router.delete('/:id/memberships/:orgId', async (req, res) => {
  try {
    if (!(await isPlatformAdmin(req))) return res.status(404).json({ error: '用户不存在' });
    const target = await (await getUserStore()).findById(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    const orgStore = await getOrgStore();
    const org = await orgStore.get(req.params.orgId);
    if (!org) return res.status(404).json({ error: '机构不存在或已被删除' });

    const mine = await orgStore.orgsOf(target.id);
    if (!mine.some((m) => String(m.org_id) === String(org.id))) {
      return res.status(404).json({ error: '该用户不属于该机构' });
    }
    if (mine.length <= 1) {
      return res.status(400).json({ error: '用户至少需要属于一个机构' });
    }
    // 既有守卫保持：不允许把机构清空到无人（与「机构管理 → 成员管理」的移出一致）。
    const members = await orgStore.membersOf(org.id);
    const others = members.filter((m) => String(m.user_id) !== String(target.id));
    if (!others.length) {
      return res.status(400).json({ error: '不能移出该机构的最后一个成员' });
    }

    await removeMember(target.id, org.id);
    await audit({
      username: req.user.username,
      action: 'REMOVE_USER_ORG',
      target: target.username,
      detail: `移出机构「${org.name}」`,
    });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
