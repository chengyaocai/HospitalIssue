import express from 'express';
import { authenticate } from '../auth/middleware.js';
import { requirePlatformAdmin } from '../auth/authorize.js';
import { getUserStore } from '../auth/index.js';
import { audit } from '../audit/index.js';
import { send500, sendError } from '../errors.js';
import { getSettings, updateSettings } from '../settings/index.js';
import {
  listOrgs, createOrg, updateOrg, removeOrg,
  getOrgStore, setMemberRole, removeMember, ensureOrgs, PLATFORM_ADMIN_ROLE,
} from '../orgs/index.js';
import { getFileStore } from '../files/index.js';
import { getSvcStore } from '../svcmanage/index.js';
import { removeStoredFiles } from '../services/uploads.js';

const router = express.Router();

// 机构管理是「跨机构」操作，仅平台管理员可用。
router.use(authenticate, requirePlatformAdmin());

// 机构列表（含成员数）；v1.18.81 附项目经理 id + 显示名（账号被删时显示名回落空）
router.get('/', async (req, res) => {
  try {
    await ensureOrgs();
    const orgs = await listOrgs();
    const users = await (await getUserStore()).list();
    const byId = new Map(users.map((u) => [String(u.id), u]));
    const enriched = orgs.map((o) => {
      const pmId = o.project_manager == null ? null : Number(o.project_manager);
      const pm = pmId != null ? byId.get(String(pmId)) : null;
      const { project_manager, ...rest } = o;
      return { ...rest, projectManagerId: pmId, projectManagerName: pm ? (pm.name || pm.username) : (pmId != null ? '（账号已删除）' : '') };
    });
    res.json({ current: req.orgId, orgs: enriched });
  } catch (e) {
    send500(res, e);
  }
});

// 公司用户候选（v1.18.81）：机构「项目经理」下拉数据源。
// 全局启用公司用户（公司用户可跨机构归属，不限于本机构成员）。
router.get('/company-users', async (req, res) => {
  try {
    const users = await (await getUserStore()).list();
    const items = users
      .filter((u) => u.userType === 'company' && u.active !== false)
      .map((u) => ({ id: u.id, username: u.username, name: u.name || u.username }));
    res.json(items);
  } catch (e) {
    send500(res, e);
  }
});

// 新建机构：默认按其机构名初始化该机构自己的系统名称；角色/权限取系统默认值，可由机构管理员自行调整。
router.post('/', async (req, res) => {
  try {
    const { code, name } = req.body || {};
    const org = await createOrg({ code, name, creatorId: req.user.id });
    await updateSettings({ appName: org.name }, org.id);
    await audit({
      username: req.user.username,
      action: 'CREATE_ORG',
      target: org.name,
      detail: `新建机构「${org.name}」（code=${org.code}）`,
    });
    res.status(201).json(org);
  } catch (e) {
    sendError(res, e);
  }
});

// 修改机构（改名 / 启用停用 / 项目经理）
router.put('/:id', async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    const before = await (await getOrgStore()).get(req.params.id);
    // 项目经理（v1.18.81）：body 携带 projectManagerId 才处理；null/空=清空；
    // 非空必须是「启用的公司用户」，防止把院方账号/任意数字设为项目经理。
    let pmAfter; let pmUser = null;
    if ('projectManagerId' in body) {
      const raw = body.projectManagerId;
      if (raw == null || raw === '') {
        body.projectManagerId = null;
        pmAfter = null;
      } else {
        const uid = Number(raw);
        if (!Number.isFinite(uid) || uid <= 0) return res.status(400).json({ error: '项目经理参数不合法' });
        const target = await (await getUserStore()).findById(uid);
        if (!target) return res.status(404).json({ error: '所选用户不存在' });
        if (target.userType !== 'company') return res.status(400).json({ error: '项目经理必须是公司用户' });
        if (target.active === false) return res.status(400).json({ error: '所选账号已停用，不能设为项目经理' });
        body.projectManagerId = uid;
        pmAfter = uid;
        pmUser = target;
      }
    }
    const after = await updateOrg(req.params.id, body);
    const segs = [];
    if (before && after && before.name !== after.name) segs.push(`名称：「${before.name}」→「${after.name}」`);
    if (before && after && before.active !== after.active) segs.push(`状态：${after.active ? '启用' : '停用'}`);
    if (after && 'projectManagerId' in body) {
      const pmBefore = before ? (before.project_manager == null ? null : Number(before.project_manager)) : null;
      if (pmBefore !== pmAfter) {
        const label = (u) => (u ? `${u.name || u.username}（${u.username}）` : '无');
        const prevUser = pmBefore != null ? await (await getUserStore()).findById(pmBefore) : null;
        segs.push(`项目经理：${label(prevUser)}→${label(pmUser)}`);
      }
    }
    await audit({
      username: req.user.username,
      action: 'UPDATE_ORG',
      target: after ? after.name : String(req.params.id),
      detail: segs.length ? segs.join('；') : '无实质变更',
    });
    res.json(after);
  } catch (e) {
    sendError(res, e);
  }
});

// 删除机构（守卫：至少保留一个；默认机构不可删）
router.delete('/:id', async (req, res) => {
  try {
    const before = await (await getOrgStore()).get(req.params.id);
    await removeOrg(req.params.id);
    // 文件管理（v1.18.70）：级联清理该机构上传的文件（登记 + 磁盘），防孤儿文件；
    // 清理失败只记日志，不阻塞机构删除（磁盘孤儿可人工再清）。
    try {
      const removedFiles = await (await getFileStore()).removeByOrg(req.params.id);
      if (removedFiles.length) {
        await removeStoredFiles(removedFiles.map((f) => ({ storedName: f.stored_name })));
      }
    } catch (e) {
      console.error('[orgs] 清理机构文件失败：', e && e.message ? e.message : e);
    }
    // 业务服务管理（v1.18.82）：级联清理该机构登记的服务记录，防跨机构孤儿数据。
    try {
      await (await getSvcStore()).removeByOrg(req.params.id);
    } catch (e) {
      console.error('[orgs] 清理机构业务服务失败：', e && e.message ? e.message : e);
    }
    await audit({
      username: req.user.username,
      action: 'DELETE_ORG',
      target: before ? before.name : String(req.params.id),
      detail: `删除机构「${before ? before.name : req.params.id}」`,
    });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

// 某机构的成员列表（含用户姓名 / 账号 / 全局启停状态与机构内角色）
// 另附：该机构可用的角色集合、以及「尚未加入本机构的启用用户」候选（供界面做成员指派）。
//
// v1.18.10：`role` 返回的是**生效角色**（平台管理员一律为管理员），并附
// `storedRole` / `roleFixed` —— 界面据此把平台管理员的角色下拉换成说明文字，
// 避免「改了下拉却不生效」的假控件。
router.get('/:id/members', async (req, res) => {
  try {
    const org = await (await getOrgStore()).get(req.params.id);
    if (!org) return res.status(404).json({ error: '机构不存在或已被删除' });
    const members = await (await getOrgStore()).membersOf(req.params.id);
    const users = await (await getUserStore()).list();
    const byId = new Map(users.map((u) => [String(u.id), u]));
    const memberIds = new Set(members.map((m) => String(m.user_id)));
    const settings = await getSettings(org.id);
    res.json({
      org,
      roles: settings.roles,
      members: members.map((m) => {
        const u = byId.get(String(m.user_id));
        const isPA = !!u && u.platformAdmin === true;
        const stored = m.role || (u ? u.role : '');
        return {
          userId: m.user_id,
          username: u ? u.username : '',
          name: u ? u.name : '（账号已删除）',
          role: isPA ? PLATFORM_ADMIN_ROLE : stored,
          storedRole: stored,
          roleFixed: isPA,
          active: u ? u.active !== false : false,
          platformAdmin: isPA,
        };
      }),
      // 候选：全局账号存在、已启用、且当前不属于本机构
      candidates: users
        .filter((u) => u.active !== false && !memberIds.has(String(u.id)))
        .map((u) => ({
          id: u.id,
          username: u.username,
          name: u.name || u.username,
          role: u.role,
          // 平台管理员加入任何机构都会被固定为管理员，界面据此预先锁定角色选择
          platformAdmin: u.platformAdmin === true,
        })),
    });
  } catch (e) {
    send500(res, e);
  }
});

// 把某用户加入该机构（或修改其机构内角色）
router.post('/:id/members', async (req, res) => {
  try {
    const userId = Number((req.body && req.body.userId) ?? NaN);
    const role = String((req.body && req.body.role) || '').trim();
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: '请选择要加入的用户' });

    const org = await (await getOrgStore()).get(req.params.id);
    if (!org) return res.status(404).json({ error: '机构不存在或已被删除' });
    const settings = await getSettings(org.id);
    const roleKeys = settings.roles.map((r) => r.key);
    if (!roleKeys.includes(role)) return res.status(400).json({ error: '角色不存在' });

    const target = await (await getUserStore()).findById(userId);
    if (!target) return res.status(404).json({ error: '用户不存在' });

    const { role: finalRole, coerced } = await setMemberRole(userId, org.id, role);
    await audit({
      username: req.user.username,
      action: 'UPDATE_ORG_MEMBER',
      target: target.username,
      detail: `机构「${org.name}」角色设为 ${finalRole}${coerced ? `（平台管理员固定为 ${PLATFORM_ADMIN_ROLE}，原选择 ${role} 未生效）` : ''}`,
    });
    res.json({ ok: true, userId, role: finalRole, coerced });
  } catch (e) {
    sendError(res, e);
  }
});

// 把某用户移出该机构
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const org = await (await getOrgStore()).get(req.params.id);
    if (!org) return res.status(404).json({ error: '机构不存在或已被删除' });
    const target = await (await getUserStore()).findById(userId);
    if (!target) return res.status(404).json({ error: '用户不存在' });

    // 守卫：不允许把机构清空到无人（至少保留一个成员），避免出现无人可管的机构。
    const members = await (await getOrgStore()).membersOf(org.id);
    const others = members.filter((m) => String(m.user_id) !== String(userId));
    if (!others.length) {
      return res.status(400).json({ error: '不能移出该机构的最后一个成员' });
    }

    await removeMember(userId, org.id);
    await audit({
      username: req.user.username,
      action: 'REMOVE_ORG_MEMBER',
      target: target.username,
      detail: `移出机构「${org.name}」`,
    });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
