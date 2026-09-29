import { getSettings } from '../settings/index.js';
import { permissionsFor } from '../permissions.js';
import { getUserStore } from './index.js';
import { send500 } from '../errors.js';

// 基于系统设置里的角色权限做接口级鉴权：action 形如 'issue.delete' / 'user.manage'
// 注意：必须在 authenticate 之后使用（依赖 req.user.role 与 req.orgId）。
// 多机构（v1.18）：权限取「当前机构」的机构级设置 —— req.orgId 由 authenticate 注入；
// 缺失时（未过 authenticate 的调用）回落全局设置，保持旧行为。
// 权限模型为 deny-by-default：角色未知或未授权一律 403。
export function requirePermission(action) {
  return async function (req, res, next) {
    try {
      const { permissions } = await getSettings(req && req.orgId);
      const role = (req.user && req.user.role) || null;
      const perms = permissionsFor(permissions, role);
      if (perms && perms.actions && perms.actions[action] === true) return next();
      return res.status(403).json({ error: '没有执行此操作的权限' });
    } catch (e) {
      console.error('[authorize]', e && e.stack ? e.stack : e);
      const msg = (e && e.message) || '';
      return res.status(500).json({
        error: msg.includes('数据库连接失败') ? msg : '服务器内部错误，请稍后重试或联系管理员',
      });
    }
  };
}

// 平台管理员专用（跨机构管理：机构增删改、成员分配、平台管理员指派）。
// 必须在 authenticate 之后使用。
//
// 【为什么查库而不是只看 token 声明】
// 1) 升级前签发的旧 token 不含 platform 声明（v1.18 新增）——只信声明会把**真实的平台管理员**
//    误拒成 403，而前端 /auth/me 是现查数据库的、会正常显示「平台管理员」标记与「机构管理」菜单，
//    于是出现「界面有权限、点了报 403」的矛盾（v1.18.1 修复的真实线上问题）。
// 2) 反过来，平台管理员被取消后必须**立即失效**：若只信 token，被撤销者在 token 剩余有效期
//    （12 小时）内仍能跨机构操作。
// 本守卫只用于 /api/orgs/* 与平台管理员指派这类低频接口，多一次读库可接受。
// 判断当前登录用户是否为平台管理员 —— **以库为准**，不看 token 里的 platform 声明
// （理由与 requirePlatformAdmin 完全一致：旧 token 无该声明、被撤销后声明仍为 true）。
// 用途：路由内部需要「平台管理员可跨机构、普通机构管理员仅限本机构」这类分支判断时，
// 取这个布尔值；需要整段拦截时仍用 requirePlatformAdmin()（它额外负责 401/403 响应）。
// 仅用于低频接口（如重置密码、停用账号），每次调用多一次读库可接受。
export async function isPlatformAdmin(req) {
  if (!req.user || req.user.id == null) return false;
  const store = await getUserStore();
  const user = await store.findById(req.user.id);
  return !!(user && user.platformAdmin === true);
}

export function requirePlatformAdmin() {
  return async function (req, res, next) {
    try {
      if (!req.user || req.user.id == null) {
        return res.status(401).json({ error: '未登录或登录已失效，请重新登录' });
      }
      const store = await getUserStore();
      const user = await store.findById(req.user.id);
      if (!user) return res.status(401).json({ error: '账号不存在或已被删除，请重新登录' });
      if (user.platformAdmin !== true) {
        return res.status(403).json({ error: '仅平台管理员可执行此操作' });
      }
      // 回写，使后续处理（以及同请求内其它判断）与库中真实状态一致
      req.user.platform = true;
      req.user.platformAdmin = true;
      return next();
    } catch (e) {
      console.error('[authorize]', e && e.stack ? e.stack : e);
      return send500(res, e);
    }
  };
}
