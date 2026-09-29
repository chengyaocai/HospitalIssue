import express from 'express';
import { getSettings, updateSettings } from '../settings/index.js';
import { normalizeRoles, BUILTIN_ROLES, MENUS, ACTIONS } from '../permissions.js';
import { getUserStore } from '../auth/index.js';
import { authenticate, resolveOrgIdSoft } from '../auth/middleware.js';
import { requirePermission } from '../auth/authorize.js';
import { audit } from '../audit/index.js';
import { send500, sendError } from '../errors.js';
import { getOrgStore, membersWithUser } from '../orgs/index.js';

const router = express.Router();

// ===== 处理人候选名单（v1.18.16）=====
// 处理人候选不再来自「系统设置 → 处理人候选名单」的手工维护名单（该界面已移除，
// settings 存储里的 handlers 仅留档、不再被读取），改为**实时派生**自「当前机构花名册
// 中的公司用户」（app_user.user_type === 'company'，v1.18.12 引入）：
//   empId  = 登录账号 username（用户数据无工号字段，以登录账号代替）；
//   name   = 姓名（缺省回落登录账号）；
//   phone  = 用户的联系电话（v1.18.17 打通：app_user 新增 phone 列；未填为空串，前端对空值已优雅降级）。
// 结构与旧版手工名单完全一致（{ empId, name, phone }），消费方（ProblemForm / DutyRoster）
// 按姓名匹配、零逻辑改动。停用账号（active === false）不进候选；按姓名排序保证展示稳定。
// 公开端点 GET /api/config 也会带此名单（与旧行为一致），因此必须容错 —— 派生失败时
// 返回空数组而不是让整个 config 500。
export async function deriveHandlersFromOrgUsers(orgId) {
  try {
    const members = await membersWithUser(orgId);
    return members
      .filter((u) => (u.userType || 'hospital') === 'company' && u.active !== false)
      .map((u) => ({ empId: String(u.username ?? ''), name: u.name || u.username || '', phone: u.phone || '' }))
      .filter((h) => h.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  } catch {
    // 机构花名册不可用时降级为空名单：处理人下拉为空（可手填），不影响 config 其余字段。
    return [];
  }
}

// ===== 审计详情中文化：把设置变更 diff 成可读中文（避免「A -> A」「handlers(7)」这类机器串）=====

// 菜单 / 功能 key → 中文 label（仅用于审计详情展示，勿用于鉴权判断）
const MENU_LABELS = Object.fromEntries(MENUS.map((m) => [m.key, m.label]));
const ACTION_CN_LABELS = Object.fromEntries(ACTIONS.map((a) => [a.key, a.label]));

// 处理人名单 diff：按姓名对比，输出 新增 / 移除 / 更新（同姓名但工号或电话变化）三类。
// 任一类为空省略；整段无变化返回空串。
function describeHandlersChange(beforeHandlers, afterHandlers) {
  const bList = Array.isArray(beforeHandlers) ? beforeHandlers : [];
  const aList = Array.isArray(afterHandlers) ? afterHandlers : [];
  const bByName = new Map(bList.map((h) => [h.name, h]));
  const aByName = new Map(aList.map((h) => [h.name, h]));
  const added = aList.filter((h) => !bByName.has(h.name)).map((h) => h.name);
  const removed = bList.filter((h) => !aByName.has(h.name)).map((h) => h.name);
  const updated = aList
    .filter((h) => {
      const b = bByName.get(h.name);
      return !!b && (b.empId !== h.empId || b.phone !== h.phone);
    })
    .map((h) => h.name);
  const segs = [];
  if (added.length) segs.push(`新增${added.length}人（${added.join('、')}）`);
  if (removed.length) segs.push(`移除${removed.length}人（${removed.join('、')}）`);
  if (updated.length) segs.push(`更新${updated.length}人（${updated.join('、')}）`);
  return segs.length ? `处理人名单：${segs.join('；')}` : '';
}

// 软件系统 diff：字符串数组按内容对比，输出新增 / 移除。
function describeSystemsChange(beforeSystems, afterSystems) {
  const bList = Array.isArray(beforeSystems) ? beforeSystems : [];
  const aList = Array.isArray(afterSystems) ? afterSystems : [];
  const bSet = new Set(bList);
  const aSet = new Set(aList);
  const added = aList.filter((s) => !bSet.has(s));
  const removed = bList.filter((s) => !aSet.has(s));
  const segs = [];
  if (added.length) segs.push(`新增${added.map((s) => `「${s}」`).join('、')}`);
  if (removed.length) segs.push(`移除${removed.map((s) => `「${s}」`).join('、')}`);
  return segs.length ? `软件系统：${segs.join('；')}` : '';
}

// 角色列表 diff：新增 / 删除 / 改名（旧label→新label），全部按 label 展示。
function describeRolesChange(beforeRoles, afterRoles) {
  const bMap = new Map((Array.isArray(beforeRoles) ? beforeRoles : []).map((r) => [r.key, r.label]));
  const aMap = new Map((Array.isArray(afterRoles) ? afterRoles : []).map((r) => [r.key, r.label]));
  const added = [...aMap.keys()].filter((k) => !bMap.has(k));
  const removed = [...bMap.keys()].filter((k) => !aMap.has(k));
  const renamed = [...aMap.keys()].filter((k) => bMap.has(k) && bMap.get(k) !== aMap.get(k));
  const segs = [];
  if (added.length) segs.push(`新增角色：${added.map((k) => `「${aMap.get(k)}」`).join('、')}`);
  if (removed.length) segs.push(`删除角色：${removed.map((k) => `「${bMap.get(k)}」`).join('、')}`);
  if (renamed.length) segs.push(`角色改名：${renamed.map((k) => `「${bMap.get(k)}」→「${aMap.get(k)}」`).join('、')}`);
  return segs.join('；');
}

// 单角色权限 diff：对比 menus 与 actions，仅列有变化项，key 一律转中文 label。
// beforePerm 缺失（新角色，无对比基线）时返回空串——新增角色已由「新增角色」段表达，避免整表刷屏。
function describeRolePermsChange(roleLabel, beforePerm, afterPerm) {
  if (!afterPerm || !beforePerm) return '';
  const bMenus = Array.isArray(beforePerm.menus) ? beforePerm.menus : [];
  const aMenus = Array.isArray(afterPerm.menus) ? afterPerm.menus : [];
  const bMenuSet = new Set(bMenus);
  const aMenuSet = new Set(aMenus);
  const mAdd = aMenus.filter((k) => !bMenuSet.has(k)).map((k) => MENU_LABELS[k] || k);
  const mRem = bMenus.filter((k) => !aMenuSet.has(k)).map((k) => MENU_LABELS[k] || k);
  const bActions = beforePerm.actions || {};
  const aActions = afterPerm.actions || {};
  const aAdd = [];
  const aRem = [];
  for (const key of Object.keys(aActions)) {
    if (bActions[key] === aActions[key]) continue;
    (aActions[key] ? aAdd : aRem).push(ACTION_CN_LABELS[key] || key);
  }
  const segs = [];
  if (mAdd.length || mRem.length) {
    segs.push(`菜单 ${[...mAdd.map((l) => '+' + l), ...mRem.map((l) => '-' + l)].join('/')}`);
  }
  if (aAdd.length || aRem.length) {
    segs.push(`功能 ${[...aAdd.map((l) => '+' + l), ...aRem.map((l) => '-' + l)].join('/')}`);
  }
  return segs.length ? `${roleLabel}：${segs.join('；')}` : '';
}

// 生成「修改系统设置」审计详情：逐字段 diff，全部无变化时输出「无实质变更」。
// before / after 均为 getSettings/updateSettings 归一化后的完整设置对象；body 为原始请求体。
export function describeSettingsChange(before, after, body) {
  const parts = [];

  // 1) 系统名称：仅真实变化时输出（杜绝 A -> A）
  if (before.appName !== after.appName) {
    parts.push(`系统名称：「${before.appName}」→「${after.appName}」`);
  }

  // 2) 处理人名单
  const h = describeHandlersChange(before.handlers, after.handlers);
  if (h) parts.push(h);

  // 3) 软件系统
  const s = describeSystemsChange(before.softwareSystems, after.softwareSystems);
  if (s) parts.push(s);

  // 4) 角色与权限：仅请求携带 roles / permissions 时进入（与旧行为的触发条件一致）
  const touchesRoles = Array.isArray(body.roles);
  const touchesPerms = !!(body.permissions && typeof body.permissions === 'object');
  if (touchesRoles || touchesPerms) {
    const segs = [];
    if (touchesRoles) {
      const r = describeRolesChange(before.roles, after.roles);
      if (r) segs.push(r);
    }
    const bPerms = before.permissions || {};
    const aPerms = after.permissions || {};
    for (const role of after.roles || []) {
      const seg = describeRolePermsChange(role.label, bPerms[role.key], aPerms[role.key]);
      if (seg) segs.push(seg);
    }
    if (segs.length) parts.push(segs.join('；'));
  }

  return parts.length ? parts.join('；') : '无实质变更';
}

// 详情截断：≤500 字符，超出以「…」结尾（总长仍 ≤500）。
function truncateDetail(text, max = 500) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

// 公开：前端读取系统名称 + 角色/权限等（登录页也需要）。
// 多机构：已登录则返回「当前机构」的设置，未登录回落默认机构 —— 登录页展示默认机构品牌。
// v1.18.16：handlers 改为实时派生自「当前机构的 company 用户」（见 deriveHandlersFromOrgUsers），
// 不再回传 settings 存储里的手工名单（stored handlers 仅留档）。
router.get('/config', async (req, res) => {
  try {
    const orgId = await resolveOrgIdSoft(req);
    const [settings, handlers] = await Promise.all([
      getSettings(orgId),
      deriveHandlersFromOrgUsers(orgId),
    ]);
    res.json({ ...settings, handlers });
  } catch (e) {
    send500(res, e);
  }
});

// 具备「修改系统设置」权限的角色：修改系统设置（作用于当前机构）
router.put('/settings', authenticate, requirePermission('settings.edit'), async (req, res) => {
  try {
    const before = await getSettings(req.orgId);
    const body = req.body || {};

    if (Array.isArray(body.roles)) {
      // 1) 内置角色不可删除（只可改名）：按「原始 payload」校验 key 是否齐全。
      const rawKeys = new Set(
        body.roles
          .filter((r) => r && typeof r.key === 'string')
          .map((r) => r.key.trim())
      );
      for (const b of BUILTIN_ROLES) {
        if (!rawKeys.has(b.key)) {
          return res.status(400).json({ error: '内置角色不可删除，只可改名' });
        }
      }
      // 2) 被移除的角色若仍被「本机构的成员」使用，则禁止删除（机构级角色集合，互不影响）。
      const nextKeys = new Set(normalizeRoles(body.roles).map((r) => r.key));
      const removed = before.roles.filter((r) => !nextKeys.has(r.key));
      if (removed.length) {
        const usage = await countRoleUsageInOrg(req.orgId);
        for (const role of removed) {
          const used = usage.get(role.key) || 0;
          if (used > 0) {
            return res.status(400).json({ error: `角色『${role.label}』下仍有 ${used} 个用户，请先调整这些用户的角色` });
          }
        }
      }
    }

    const after = await updateSettings(body, req.orgId);
    // 「无实质变更」不落审计日志（v1.6 降噪）：diff 为空时跳过 audit()
    const detail = truncateDetail(describeSettingsChange(before, after, body));
    if (detail !== '无实质变更') {
      await audit({
        username: req.user.username,
        action: 'UPDATE_SETTINGS',
        target: '系统设置',
        detail,
      });
    }
    res.json(after);
  } catch (e) {
    // 锁死保护等业务异常自带 status（400），其它错误仍按 500 处理。
    sendError(res, e);
  }
});

// 统计「某机构内各角色被多少用户使用」：机构内有成员关系者按其机构内角色计，
// 无成员关系者按其全局角色计（保证升级后单机构场景与旧统计完全一致）。
async function countRoleUsageInOrg(orgId) {
  const store = await getUserStore();
  const users = await store.list();
  const orgStore = await getOrgStore();
  const members = await orgStore.membersOf(orgId);
  const roleByUser = new Map(members.map((m) => [String(m.user_id), m.role]));
  const usage = new Map();
  for (const u of users) {
    const role = roleByUser.get(String(u.id)) || u.role;
    if (!role) continue;
    usage.set(role, (usage.get(role) || 0) + 1);
  }
  return usage;
}

export default router;
