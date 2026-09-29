import { ref } from 'vue';
import { api } from './api.js';

// 全局共享未读数：导航栏徽标 / 右下角铃铛 / 消息页 共用同一份，保证两处同步。
export const unread = ref(0);

let timer = null;

// 拉取最新未读数并写入共享状态（未登录 / 网络异常时静默忽略）
export async function refreshUnread() {
  try {
    const r = await api.notificationsUnreadCount();
    unread.value = Number(r.unread) || 0;
  } catch { /* 未登录 / 网络异常：静默 */ }
}

// 直接设置未读数（列表接口已返回 unread 时使用）
export function setUnread(n) { unread.value = Math.max(0, Number(n) || 0); }
// 单条已读后递减
export function decUnread() { unread.value = Math.max(0, unread.value - 1); }
// 全部已读后清零
export function clearUnread() { unread.value = 0; }

// 单例轮询：全局只允许存在一个定时器（App 登录后启动、登出停止）
export function startUnreadPolling(intervalMs = 30000) {
  if (timer) return;
  timer = setInterval(refreshUnread, intervalMs);
}
export function stopUnreadPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}
export function isPolling() { return !!timer; }

// ISO -> 刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD HH:mm（全局唯一实现）
export function fmtTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const day = Math.floor(hr / 24);
  if (day < 7) return day + ' 天前';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
