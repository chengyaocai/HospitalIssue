import { config } from '../config.js';
import { createDevNotificationStore } from './devNotificationStore.js';
import { createMssqlNotificationStore } from './mssqlNotificationStore.js';

// 单次发送（含 fan-out）的接收人上限。
const MAX_RECIPIENTS = 500;

let store;

// 工厂：dev 用 JSON 文件，生产用 SQL Server（模块级缓存）。
export async function getNotificationStore() {
  if (store) return store;
  store = config.dbDriver === 'dev'
    ? createDevNotificationStore(config.notificationsDevPath)
    : createMssqlNotificationStore(config.mssql);
  return store;
}

// 归一化接收人：字符串 / 字符串数组 -> 去重、去空、trim 后的账号数组。
function normalizeRecipients(to) {
  const arr = Array.isArray(to) ? to : [to];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const u = String(item ?? '').trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

export async function unreadCount(username, orgId) {
  return (await getNotificationStore()).unreadCount(username, orgId);
}

export async function listForUser(username, opts = {}) {
  return (await getNotificationStore()).listForUser(username, opts);
}

export async function markRead(id, username, orgId) {
  return (await getNotificationStore()).markRead(id, username, orgId);
}

export async function markAllRead(username, orgId) {
  return (await getNotificationStore()).markAllRead(username, orgId);
}

// 发送通知：fan-out（每人一条）。全员广播由调用方传 broadcast=true。
// 接收人上限 500，超出抛 status=400。orgId 为通知归属机构（多机构 v1.18）。
export async function sendNotification({ title, body, from, to, broadcast = false, orgId } = {}) {
  const recipients = normalizeRecipients(to);
  if (recipients.length > MAX_RECIPIENTS) {
    const err = new Error(`接收人不能超过 ${MAX_RECIPIENTS} 人`);
    err.status = 400;
    throw err;
  }
  if (!recipients.length) return { sent: 0 };
  const entries = recipients.map((username) => ({
    org_id: orgId,
    title: String(title ?? ''),
    body: String(body ?? ''),
    from: String(from ?? ''),
    to: username,
    broadcast: broadcast === true,
    read: false,
  }));
  const s = await getNotificationStore();
  await s.addMany(entries);
  return { sent: recipients.length };
}
