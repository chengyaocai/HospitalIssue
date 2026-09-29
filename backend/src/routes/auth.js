import express from 'express';
import { getUserStore } from '../auth/index.js';
import { verifyPassword, hashPassword } from '../auth/password.js';
import { signToken } from '../auth/jwt.js';
import { authenticate } from '../auth/middleware.js';
import { audit } from '../audit/index.js';
import { send500 } from '../errors.js';
import { ensureOrgs, orgsForUser, roleInOrg, getOrgStore } from '../orgs/index.js';

const router = express.Router();

// ===== 登录防爆破（v1.6）=====
// 进程内存级计数（重启即清，单进程部署可接受），key=尝试登录的用户名：
// - 「不存在的用户名」同样计数，防止通过差异化响应枚举有效账号；
// - 连续失败达 5 次 → 锁定 10 分钟；锁定期间每次尝试顺延锁定截止时间（计数不重置）；
// - 登录成功清空该账号计数；
// - 过期条目在读取时惰性清理（Map 粒度小，无需定时器）。
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const loginAttempts = new Map(); // username -> { count, lockedUntil }

function getAttempt(username) {
  const rec = loginAttempts.get(username);
  if (!rec) return null;
  // 锁定已过期：连同计数一起清理（重新开始计数）
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
    loginAttempts.delete(username);
    return null;
  }
  return rec;
}

function isLocked(rec) {
  return !!rec && !!rec.lockedUntil && Date.now() < rec.lockedUntil;
}

// ===== 多机构（v1.18）：机构上下文解析 =====

// 解析用户的机构上下文：
// - 平台管理员（platformAdmin）可访问全部机构；
// - 普通用户仅可访问自己有成员关系的机构；
// - 当前机构优先取「首个启用机构」（orgsForUser 已按机构 id 升序，默认机构在最前）。
//
// 注意顺序：**必须先 ensureOrgs() 再读取 platformAdmin**。
// ensureOrgs() 是惰性引导：升级后的第一个请求会在这里「建默认机构 / 提升首个 admin 为平台管理员 /
// 复制全局设置」，若在它之前就读 platformAdmin，会把引导前的旧值（false）写进 token 的 platform 声明，
// 导致这个真实平台管理员此后 12 小时内所有跨机构接口都被 403（v1.18.1 修复）。
async function resolveOrgContext(user) {
  await ensureOrgs();
  const fresh = (await (await getUserStore()).findById(user.id)) || user;
  const platform = fresh.platformAdmin === true;
  const all = await orgsForUser(fresh.id, fresh.role, platform);
  const usable = all.filter((o) => o.active);
  const current = usable[0] || all[0] || null;
  if (!current) return { platform, orgs: all, current: null, role: fresh.role };
  const role = await roleInOrg(fresh.id, current.id, fresh.role, platform);
  return {
    platform,
    orgs: all,
    current: { id: current.id, code: current.code, name: current.name, active: current.active },
    role,
  };
}

// 组装签发给前端的登录态：token（含 org / platform 声明）+ 用户 + 机构上下文。
// role 一律为「当前机构内」的有效角色 —— 权限判定不再依赖全局角色。
function buildSession(user, ctx) {
  const token = signToken({
    sub: user.id,
    username: user.username,
    name: user.name,
    role: ctx.role,
    org: ctx.current ? ctx.current.id : null,
    platform: ctx.platform,
  });
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: ctx.role,
      platformAdmin: ctx.platform,
    },
    org: ctx.current,
    orgs: ctx.orgs,
  };
}

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    // 锁定检查：锁定期间直接拒绝（无论密码是否正确），并顺延锁定时间
    const attempt = getAttempt(String(username));
    if (isLocked(attempt)) {
      attempt.lockedUntil = Date.now() + LOGIN_LOCK_MS; // 顺延，不重置
      return res.status(401).json({ error: '失败次数过多，账号已临时锁定，请 10 分钟后再试' });
    }
    const store = await getUserStore();
    const user = await store.findByUsername(username);
    if (!user || !(await verifyPassword(password, user.password))) {
      // 按尝试的用户名计数（含不存在的用户名，防枚举爆破）
      const key = String(username);
      const rec = loginAttempts.get(key) || { count: 0, lockedUntil: null };
      rec.count += 1;
      if (rec.count >= LOGIN_MAX_ATTEMPTS) {
        rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
      }
      loginAttempts.set(key, rec);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (!user.active) {
      return res.status(403).json({ error: '账号已停用，请联系管理员' });
    }
    loginAttempts.delete(String(user.username)); // 登录成功清空计数
    // 最近登录时间（v1.18.44）：登录成功即记录（失败/锁定不记）。记录失败不阻塞登录。
    try { await store.touchLogin(user.id); } catch { /* 非关键数据，忽略 */ }
    const ctx = await resolveOrgContext(user);
    // 登录日志归属「进入的机构」（登录路由不在 authenticate 的请求上下文内，需显式传入）。
    await audit({ username: user.username, action: 'LOGIN', target: user.username, orgId: ctx.current ? ctx.current.id : undefined });
    res.json(buildSession(user, ctx));
  } catch (e) {
    send500(res, e);
  }
});

// 当前登录态：返回用户（角色以库中最新为准）+ 当前机构 + 可访问机构列表。
router.get('/me', authenticate, async (req, res) => {
  try {
    const store = await getUserStore();
    const user = await store.findById(req.user.id);
    if (!user) return res.status(401).json({ error: '账号不存在或已被删除，请重新登录' });
    if (!user.active) return res.status(403).json({ error: '账号已停用，请联系管理员' });

    const platform = user.platformAdmin === true;
    const all = await orgsForUser(user.id, user.role, platform);
    const cur = all.find((o) => String(o.id) === String(req.orgId))
      || all.find((o) => o.active)
      || all[0]
      || null;
    const role = cur ? await roleInOrg(user.id, cur.id, user.role, platform) : user.role;

    res.json({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role,
        platformAdmin: platform,
        org: cur ? cur.id : null,
      },
      org: cur ? { id: cur.id, code: cur.code, name: cur.name, active: cur.active } : null,
      orgs: all,
    });
  } catch (e) {
    send500(res, e);
  }
});

// 切换当前机构：校验归属（平台管理员豁免）与机构启用状态，重新签发携带新 org 的 token。
router.post('/switch-org', authenticate, async (req, res) => {
  try {
    const store = await getUserStore();
    const user = await store.findById(req.user.id);
    if (!user) return res.status(401).json({ error: '账号不存在或已被删除，请重新登录' });
    if (!user.active) return res.status(403).json({ error: '账号已停用，请联系管理员' });

    const orgId = Number(req.body && req.body.orgId);
    if (!Number.isFinite(orgId) || orgId <= 0) {
      return res.status(400).json({ error: '请选择要切换的机构' });
    }
    const orgStore = await getOrgStore();
    await ensureOrgs();
    const target = await orgStore.get(orgId);
    if (!target) return res.status(404).json({ error: '机构不存在或已被删除' });
    if (!target.active) return res.status(403).json({ error: '该机构已停用，无法切换' });

    const platform = user.platformAdmin === true;
    if (!platform) {
      const mine = await orgStore.orgsOf(user.id);
      if (!mine.some((m) => String(m.org_id) === String(orgId))) {
        return res.status(403).json({ error: '您不属于该机构，无法切换' });
      }
    }

    const role = await roleInOrg(user.id, orgId, user.role, platform);
    const all = await orgsForUser(user.id, user.role, platform);
    const token = signToken({
      sub: user.id,
      username: user.username,
      name: user.name,
      role,
      org: orgId,
      platform,
    });
    await audit({
      username: user.username,
      action: 'SWITCH_ORG',
      target: target.name,
      detail: `切换到机构「${target.name}」`,
      orgId: target.id,
    });
    res.json({
      token,
      user: { id: user.id, username: user.username, name: user.name, role, platformAdmin: platform },
      org: { id: target.id, code: target.code, name: target.name, active: target.active },
      orgs: all,
    });
  } catch (e) {
    send500(res, e);
  }
});

// 修改本人密码
router.put('/password', authenticate, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入原密码和新密码' });
    if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    const store = await getUserStore();
    const user = await store.findByUsername(req.user.username);
    if (!user || !(await verifyPassword(oldPassword, user.password))) {
      return res.status(400).json({ error: '原密码错误' });
    }
    await store.setPassword(user.id, await hashPassword(newPassword));
    await audit({ username: req.user.username, action: 'CHANGE_PASSWORD', target: user.username });
    res.json({ ok: true });
  } catch (e) {
    send500(res, e);
  }
});

export default router;
