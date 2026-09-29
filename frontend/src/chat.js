import { ref } from 'vue';
import { api } from './api.js';

// 全局共享聊天未读数：导航栏「聊天」徽标使用这一份，保证与聊天页同步。
export const unread = ref(0);

let timer = null;

// 拉取最新聊天未读数并写入共享状态（未登录 / 网络异常时静默忽略）
export async function refreshUnread() {
  try {
    const r = await api.chatUnread();
    unread.value = Number(r.total) || 0;
  } catch { /* 未登录 / 网络异常：静默 */ }
}

export function setUnread(n) { unread.value = Math.max(0, Number(n) || 0); }
export function clearUnread() { unread.value = 0; }

// 单例轮询：全局只允许存在一个定时器（App 登录后启动、登出停止）
export function startChatPolling(intervalMs = 30000) {
  if (timer) return;
  timer = setInterval(refreshUnread, intervalMs);
}
export function stopChatPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}
export function isPolling() { return !!timer; }
