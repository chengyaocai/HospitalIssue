import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ORG_ID } from '../db/orgScope.js';
import { normalizeSvcType, normalizeSvcEnv } from './constants.js';

// dev / 测试用：本地 JSON 文件存储（业务服务管理，v1.18.82）。
// 统一记录字段：{ id, org_id, name, svc_type, hospital, vendor, username, password,
//                env, sort, url, path, remark, enabled, created_by, created_at, updated_at }
export function createDevSvcStore(filePath) {
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

  function normalize(rec, id) {
    return {
      id,
      org_id: rec.org_id == null ? DEFAULT_ORG_ID : Number(rec.org_id),
      name: rec.name || '',
      svc_type: normalizeSvcType(rec.svc_type),
      hospital: rec.hospital || '',
      vendor: rec.vendor || '',
      username: rec.username || '',
      password: rec.password || '',
      env: normalizeSvcEnv(rec.env),
      sort: Number(rec.sort) || 0,
      url: rec.url || '',
      path: rec.path || '',
      remark: rec.remark || '',
      enabled: rec.enabled === false ? false : true,
      created_by: rec.created_by || '',
      created_at: rec.created_at || new Date().toISOString(),
      updated_at: rec.updated_at || null,
    };
  }

  function nextId(records) {
    return records.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  }

  return {
    async init() { await load(); },

    // 列表：按当前机构过滤 → 关键字/类型/环境/启用状态过滤 → 序号升序 → 分页。
    // q 模糊匹配：服务名称 / 医院 / 厂家 / 账号 / 服务地址 / 路径 / 备注。
    async list({ q, type, env, enabled, page = 1, pageSize = 20, orgId } = {}) {
      let rows = (await load()).filter((r) => orgId == null || Number(r.org_id) === Number(orgId));
      if (q) {
        const k = String(q).toLowerCase();
        rows = rows.filter((r) =>
          [r.name, r.hospital, r.vendor, r.username, r.url, r.path, r.remark].join(' ').toLowerCase().includes(k));
      }
      if (type) rows = rows.filter((r) => r.svc_type === type);
      if (env) rows = rows.filter((r) => r.env === env);
      if (enabled === true) rows = rows.filter((r) => r.enabled);
      if (enabled === false) rows = rows.filter((r) => !r.enabled);
      const sorted = [...rows].sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
      const total = sorted.length;
      const start = (Number(page) - 1) * Number(pageSize);
      return {
        rows: sorted.slice(start, start + Number(pageSize)).map((r) => ({ ...r })),
        total,
        page: Number(page),
        pageSize: Number(pageSize),
      };
    },

    // 按 id 取记录（仅限当前机构；跨机构一律视为不存在 —— 多机构红线）。
    async getById(id, orgId) {
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const rec = (await load()).find((r) => r.id === num
        && (orgId == null || Number(r.org_id) === Number(orgId))) || null;
      return rec ? { ...rec } : null;
    },

    async create(rec) {
      const records = await load();
      const row = normalize(rec, nextId(records));
      records.push(row);
      await save(records);
      return { ...row };
    },

    // 局部更新：仅改传入字段；不存在返回 null。
    async update(id, orgId, patch = {}) {
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const rec = (await load()).find((r) => r.id === num
        && (orgId == null || Number(r.org_id) === Number(orgId)));
      if (!rec) return null;
      for (const k of ['name', 'hospital', 'vendor', 'username', 'password', 'url', 'path', 'remark']) {
        if (patch[k] != null) rec[k] = String(patch[k]);
      }
      if (patch.svc_type != null) rec.svc_type = normalizeSvcType(patch.svc_type);
      if (patch.env != null) rec.env = normalizeSvcEnv(patch.env);
      if (patch.sort != null) rec.sort = Number(patch.sort) || 0;
      if (patch.enabled != null) rec.enabled = !!patch.enabled;
      rec.updated_at = new Date().toISOString();
      await save((await load()));
      return { ...rec };
    },

    // 物理删除：返回被删记录；不存在返回 null。
    async remove(id, orgId) {
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const records = await load();
      const idx = records.findIndex((r) => r.id === num
        && (orgId == null || Number(r.org_id) === Number(orgId)));
      if (idx === -1) return null;
      const [rec] = records.splice(idx, 1);
      await save(records);
      return { ...rec };
    },

    // 机构级联清理（删除机构时用）：返回被删记录列表。
    async removeByOrg(orgId) {
      if (orgId == null) return [];
      const records = await load();
      const target = Number(orgId);
      const removed = records.filter((r) => Number(r.org_id) === target);
      if (!removed.length) return [];
      await save(records.filter((r) => Number(r.org_id) !== target));
      return removed.map((r) => ({ ...r }));
    },
  };
}
