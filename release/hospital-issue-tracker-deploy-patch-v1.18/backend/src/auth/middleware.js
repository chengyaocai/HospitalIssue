import { verifyToken } from './jwt.js';
import { defaultOrgId } from '../orgs/index.js';
import { runWithContext } from '../context.js';
import { touchPresence } from '../presence.js';

// 鉴权中间件：要求 Authorization: Bearer <token>。
// 同时解析「机构上下文」：
// - JWT 已携带 org（登录 / 切换机构时签发）→ 直接采用，无额外数据库开销；
// - 老版本 token（无 org 字段）→ 回落「默认机构」，单机构部署下行为与升级前完全一致。
// 解析结果：req.user（含 org / platform）+ req.orgId（当前机构 id）。
export async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录或登录已失效，请重新登录' });

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: '未登录或登录已失效，请重新登录' });
  }

  const platform = payload.platform === true;
  // 在线心跳（v1.18.41）：每次认证请求即视为活跃（前端 30s 轮询天然形成心跳）。
  touchPresence(payload.username);
  req.user = {
    id: payload.sub,
    username: payload.username,
    name: payload.name,
    // role 为「当前机构内」的有效角色（登录 / 切换机构时按成员关系解析后写入 token）。
    role: payload.role,
    org: payload.org ?? null,
    platform,
    platformAdmin: platform,
  };

  try {
    // 机构上下文：token 内已有 org 就零成本采用；否则回落默认机构（仅升级后 12 小时内的老 token 会走到）。
    req.orgId = req.user.org != null ? req.user.org : await defaultOrgId();
  } catch (e) {
    console.error('[authenticate] 解析机构上下文失败：', e && e.stack ? e.stack : e);
    const msg = (e && e.message) || '';
    return res.status(500).json({
      error: msg.includes('数据库连接失败') ? msg : '服务器内部错误，请稍后重试或联系管理员',
    });
  }
  // 把机构 / 账号写入请求级上下文，供审计日志等深层调用自动读取（见 context.js）。
  return runWithContext({ orgId: req.orgId, username: req.user.username }, () => next());
}

// 软解析机构上下文（不强制登录，用于 /api/config 这类公开接口）：
// token 有效且携带 org 时采用之，否则回落默认机构 —— 登录页也能看到当前机构的品牌名。
export async function resolveOrgIdSoft(req) {
  const header = (req && req.headers && req.headers.authorization) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = verifyToken(token);
      if (payload && payload.org != null) return payload.org;
    } catch { /* 无效 / 过期 token：按未登录处理，回落默认机构 */ }
  }
  return defaultOrgId();
}
