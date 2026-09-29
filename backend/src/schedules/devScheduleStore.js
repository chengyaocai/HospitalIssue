import fs from 'node:fs/promises';
import path from 'node:path';
import { addDays, diffDays } from './dateUtil.js';
import { filterByOrg, inOrg, DEFAULT_ORG_ID } from '../db/orgScope.js';

// dev / 测试用：本地 JSON 文件值班表存储。
// 统一记录字段：{ id, org_id, date, handlerUsername, handlerName, note, createdBy, createdAt, synced }
// synced（v1.18.18）：同步来源标记 —— 0/false=手工或复制周（永不被镜像同步删除），1/true=上次跨机构同步产生。
export function createDevScheduleStore(filePath) {
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
      date: entry.date || '',
      handlerUsername: entry.handlerUsername || '',
      handlerName: entry.handlerName || '',
      note: entry.note || '',
      createdBy: entry.createdBy || '',
      createdAt: entry.createdAt || new Date().toISOString(),
      // 同步来源标记（v1.18.18）：缺省视为手工条目（false），sync 侧显式传 synced:1 打标。
      synced: !!entry.synced,
    };
  }

  function nextId(records) {
    return records.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  }

  // 升序：按 date，再按 id。
  function sortAsc(records) {
    return [...records].sort((a, b) =>
      String(a.date).localeCompare(String(b.date)) || (Number(a.id) || 0) - (Number(b.id) || 0));
  }

  // 含端点的范围过滤（from / to 均可选）。
  function inRange(records, from, to) {
    return records.filter((r) => (!from || String(r.date) >= from) && (!to || String(r.date) <= to));
  }

  // 「同日同一人」判重键：有账号用账号，否则用姓名。
  function personKey(rec) {
    return `${String(rec.date)}|${rec.handlerUsername || rec.handlerName}`;
  }

  return {
    // 范围查询：from/to 为 YYYY-MM-DD，含端点，按 date 升序再 id。仅返回当前机构。
    async listRange(from, to, orgId) {
      const records = await load();
      return sortAsc(inRange(filterByOrg(records, orgId), from, to));
    },
    async findById(id, orgId) {
      const records = await load();
      const rec = records.find((r) => String(r.id) === String(id) && inOrg(r, orgId)) || null;
      return rec ? { ...rec } : null;
    },
    async create(entry) {
      const records = await load();
      const rec = normalize(entry, nextId(records));
      records.push(rec);
      await save(records);
      return { ...rec };
    },
    async update(id, patch, orgId) {
      const records = await load();
      const idx = records.findIndex((r) => String(r.id) === String(id) && inOrg(r, orgId));
      if (idx === -1) return null;
      const merged = normalize({ ...records[idx], ...patch }, records[idx].id);
      records[idx] = merged;
      await save(records);
      return { ...merged };
    },
    async remove(id, orgId) {
      const records = await load();
      const idx = records.findIndex((r) => String(r.id) === String(id) && inOrg(r, orgId));
      if (idx === -1) return false;
      records.splice(idx, 1);
      await save(records);
      return true;
    },
    // 复制周排班：把 sourceFrom 起 7 天的条目平移到 targetFrom 起的周，
    // 跳过「目标日 + 同一人」已存在的（含本次批量内的重复），返回 { copied }。
    // 仅在同一机构内复制（源与目标都限定为当前机构）。
    async copyWeek(sourceFrom, targetFrom, orgId) {
      const records = await load();
      const scoped = filterByOrg(records, orgId);
      const shift = diffDays(sourceFrom, targetFrom);
      const source = inRange(scoped, sourceFrom, addDays(sourceFrom, 6));
      const targetKeys = new Set(
        inRange(scoped, targetFrom, addDays(targetFrom, 6)).map(personKey)
      );
      let copied = 0;
      let id = nextId(records);
      for (const rec of source) {
        const next = {
          org_id: rec.org_id,
          date: addDays(String(rec.date), shift),
          handlerUsername: rec.handlerUsername || '',
          handlerName: rec.handlerName || '',
          note: rec.note || '',
          createdBy: rec.createdBy || '',
          createdAt: new Date().toISOString(),
        };
        const key = `${next.date}|${next.handlerUsername || next.handlerName}`;
        if (targetKeys.has(key)) continue;
        targetKeys.add(key);
        records.push(normalize(next, id++));
        copied++;
      }
      if (copied) await save(records);
      return { copied };
    },
  };
}
