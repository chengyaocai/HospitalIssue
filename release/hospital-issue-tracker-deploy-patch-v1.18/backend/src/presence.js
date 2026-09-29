// 在线状态（v1.18.41）：内存态「最后活跃时间」表。
// authenticate 中间件每次带 token 请求都 touch 一次 —— 前端本身有 30s 轮询（通知/聊天未读），
// 天然形成心跳；在线 = 最近 ONLINE_WINDOW_MS 内有过任意认证请求。
// 刻意不落库：在线是瞬态信息，后端重启清零 = 「各端需重新活跃一次才显示在线」，语义正确；
// 也因此多实例部署下各实例独立计数（本系统单实例部署，无影响）。
const lastSeen = new Map(); // username -> Date.now()

// 在线判定窗口：略大于前端最长的轮询间隔（通知 30s / 聊天 15s），留出网络抖动容差。
export const ONLINE_WINDOW_MS = 90 * 1000;

export function touchPresence(username) {
  if (username) lastSeen.set(username, Date.now());
}

// 返回窗口内仍活跃的账号名列表；顺手清理过期项，防 Map 无界增长。
export function onlineUsernames(now = Date.now()) {
  const out = [];
  for (const [u, t] of lastSeen) {
    if (now - t <= ONLINE_WINDOW_MS) out.push(u);
    else lastSeen.delete(u);
  }
  return out;
}
