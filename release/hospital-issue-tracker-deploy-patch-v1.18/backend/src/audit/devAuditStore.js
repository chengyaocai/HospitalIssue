import fs from 'node:fs/promises';
import path from 'node:path';
import { filterByOrg, DEFAULT_ORG_ID } from '../db/orgScope.js';

function ts(v, endOfDay) {
  if (!v) return null;
  let d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) d = new Date(String(v) + 'T23:59:59.999');
  return d.getTime();
}

// dev / 测试用：本地 JSON 文件审计日志。
// 统一记录字段：{ id, org_id, username, action, target, detail, created_at }
export function createDevAuditStore(filePath) {
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

  function filter(logs, f = {}) {
    const fromTs = ts(f.from, false);
    const toTs = ts(f.to, true);
    return filterByOrg(logs, f.orgId).filter((r) => {
      if (f.action && r.action !== f.action) return false;
      if (f.username && r.username !== f.username) return false;
      if (fromTs !== null || toTs !== null) {
        const t = new Date(r.created_at).getTime();
        if (fromTs !== null && t < fromTs) return false;
        if (toTs !== null && t > toTs) return false;
      }
      return true;
    });
  }

  return {
    async add(entry) {
      const logs = await load();
      const rec = {
        id: logs.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1,
        // 机构归属（v1.18）：缺省落默认机构
        org_id: entry.org_id == null ? DEFAULT_ORG_ID : Number(entry.org_id),
        username: entry.username || '',
        action: entry.action || '',
        target: entry.target || '',
        detail: entry.detail || '',
        created_at: new Date().toISOString(),
      };
      logs.push(rec);
      await save(logs);
      return rec;
    },
    async list({ action, username, from, to, page = 1, pageSize = 50, orgId } = {}) {
      const logs = await load();
      const filtered = filter(logs, { action, username, from, to, orgId });
      const sorted = [...filtered].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const total = sorted.length;
      const start = (Number(page) - 1) * Number(pageSize);
      return { rows: sorted.slice(start, start + Number(pageSize)), total };
    },
    async exportRows({ action, username, from, to, orgId } = {}) {
      const logs = await load();
      return filter(logs, { action, username, from, to, orgId })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
  };
}
