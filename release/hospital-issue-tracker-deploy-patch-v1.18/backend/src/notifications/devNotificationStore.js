import fs from 'node:fs/promises';
import path from 'node:path';
import { filterByOrg, inOrg, DEFAULT_ORG_ID } from '../db/orgScope.js';

// dev / 测试用：本地 JSON 文件消息通知存储。
// 统一记录字段：{ id, org_id, title, body, from, to, broadcast, read, created_at }
export function createDevNotificationStore(filePath) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      cache = JSON.parse(raw);
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      cache = [];
      await fs.writeFile(filePath, '[]', 'utf8');
    }
    return cache;
  }

  async function save(data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    cache = data;
  }

  // 补默认值并统一为「统一字段名」。
  function normalize(entry, id) {
    return {
      id,
      // 机构归属（v1.18）：缺省落默认机构
      org_id: entry.org_id == null ? DEFAULT_ORG_ID : Number(entry.org_id),
      title: entry.title || '',
      body: entry.body || '',
      from: entry.from || '',
      to: entry.to || '',
      broadcast: entry.broadcast === true,
      read: entry.read === true,
      created_at: entry.created_at || new Date().toISOString(),
    };
  }

  function nextId(records) {
    return records.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  }

  return {
    async add(entry) {
      const records = await load();
      const rec = normalize(entry, nextId(records));
      records.push(rec);
      await save(records);
      return rec;
    },
    // 批量写入：一次 load/save 内为多条记录分配连续 id（全员广播走这里，避免 N 次写盘）。
    async addMany(entries) {
      const list = entries || [];
      if (!list.length) return [];
      const records = await load();
      let id = nextId(records);
      const out = [];
      for (const entry of list) {
        const rec = normalize(entry, id++);
        records.push(rec);
        out.push(rec);
      }
      await save(records);
      return out;
    },
    // 返回 { rows: 截断到 limit 条, unread: 过滤前的未读总数 }。
    async listForUser(username, { unread = false, limit = 50, orgId } = {}) {
      const records = await load();
      const mine = filterByOrg(records, orgId).filter((r) => r.to === username);
      const unreadTotal = mine.filter((r) => r.read !== true).length;
      const filtered = unread ? mine.filter((r) => r.read !== true) : mine;
      const sorted = [...filtered].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return { rows: sorted.slice(0, Number(limit)), unread: unreadTotal };
    },
    async unreadCount(username, orgId) {
      const records = await load();
      return filterByOrg(records, orgId).filter((r) => r.to === username && r.read !== true).length;
    },
    // 仅当 to === username 且归属当前机构才置已读；找不到 / 不属于 -> false；已读再标一次 -> true（幂等）。
    async markRead(id, username, orgId) {
      const records = await load();
      const rec = records.find((r) => String(r.id) === String(id) && r.to === username && inOrg(r, orgId));
      if (!rec) return false;
      if (rec.read !== true) {
        rec.read = true;
        await save(records);
      }
      return true;
    },
    async markAllRead(username, orgId) {
      const records = await load();
      let n = 0;
      for (const r of records) {
        if (r.to === username && r.read !== true && inOrg(r, orgId)) {
          r.read = true;
          n++;
        }
      }
      if (n) await save(records);
      return n;
    },
  };
}
