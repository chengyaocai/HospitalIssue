import fs from 'node:fs/promises';
import path from 'node:path';
import { sortRows } from './sort.js';
import { computeDashboard } from './aggregate.js';
import { filterByOrg, inOrg, DEFAULT_ORG_ID } from './orgScope.js';

function groupCount(rows, key) {
  const m = {};
  for (const r of rows) {
    const k = r[key] || '未知';
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

// 筛选值归一化（v1.18.45 多选）：兼容数组（新）与单字符串（旧调用方/测试），统一为数组判断「包含」。
function asMulti(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  return v ? [v] : [];
}

function applyFilters(rows, f = {}) {
  return rows.filter((r) => {
    const st = asMulti(f.status);
    if (st.length && !st.includes(r.status)) return false;
    if (f.auditStatus && (r.audit_status || '待审核') !== f.auditStatus) return false;
    const tp = asMulti(f.type);
    if (tp.length && !tp.includes(r.type)) return false;
    const dp = asMulti(f.department);
    if (dp.length && !dp.includes(r.department)) return false;
    if (f.keyword) {
      const k = String(f.keyword).toLowerCase();
      const hay = [r.title, r.department, r.reporter, r.description, r.handler, r.registrar, r.softwareSystem].join(' ').toLowerCase();
      if (!hay.includes(k)) return false;
    }
    return true;
  });
}

// 月度趋势：按 created_at 的 YYYY-MM 归并，返回升序序列
function groupByMonth(rows) {
  const m = {};
  for (const r of rows) {
    const key = (r.created_at || '').slice(0, 7);
    if (key) m[key] = (m[key] || 0) + 1;
  }
  return Object.entries(m).map(([month, count]) => ({ month, count })).sort((a, b) => (a.month < b.month ? -1 : 1));
}

// 回收站（v1.6 软删除）行级过滤：
// - deleted=true  → 仅返回已软删除的记录（回收站视图）；
// - deleted=false/undefined → 仅返回未删除的记录（默认所有读路径）。
function filterByDeleted(rows, deleted) {
  return deleted
    ? rows.filter((r) => r.deleted_at)
    : rows.filter((r) => !r.deleted_at);
}

// 旧记录（v1.2 之前）没有审核字段：读取时统一兜底为「待审核」
function normalizeAudit(r) {
  if (!r.audit_status) r.audit_status = '待审核';
  if (r.audit_reason == null) r.audit_reason = '';
  if (r.audit_by == null) r.audit_by = '';
  if (r.audit_at == null) r.audit_at = null;
  return r;
}

// dev / 测试用：本地 JSON 文件仓库，无需数据库即可跑通。
export function createDevRepo(filePath) {
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

  return {
    async init() { await load(); },

    async list({ status, type, department, keyword, auditStatus, deleted, page = 1, pageSize = 20, sort, order, orgId } = {}) {
      const rows = await load();
      // 机构隔离（v1.18）→ 软删除过滤：默认仅未删除记录；deleted=true 时仅回收站记录
      const scoped = filterByOrg(rows, orgId);
      const filtered = applyFilters(filterByDeleted(scoped, deleted), { status, type, department, keyword, auditStatus });
      const sorted = sortRows(filtered, sort, order);
      const total = sorted.length;
      const start = (Number(page) - 1) * Number(pageSize);
      const paged = sorted.slice(start, start + Number(pageSize)).map(normalizeAudit);
      return { rows: paged, total };
    },

    // 运维知识库（v1.18.27）：派生视图 —— 所有写了处理说明（resolution 非空）的问题自动收录。
    // 口径：本机构 + 未删除 + resolution trim 后非空；只读展示，支持 keyword / type / 排序 / 分页。
    async listKb({ keyword, type, page = 1, pageSize = 20, sort, order, orgId } = {}) {
      const rows = await load();
      const active = filterByDeleted(filterByOrg(rows, orgId), false);
      let filtered = active.filter((r) => String(r.resolution || '').trim() !== '');
      if (type) filtered = filtered.filter((r) => r.type === type);
      if (keyword) {
        const k = String(keyword).toLowerCase();
        filtered = filtered.filter((r) => {
          const hay = [r.title, r.description, r.resolution, r.softwareSystem, r.department, r.handler].join(' ').toLowerCase();
          return hay.includes(k);
        });
      }
      const sorted = sortRows(filtered, sort, order);
      const total = sorted.length;
      const start = (Number(page) - 1) * Number(pageSize);
      const paged = sorted.slice(start, start + Number(pageSize)).map(normalizeAudit);
      return { rows: paged, total, page: Number(page), pageSize: Number(pageSize) };
    },

    // 详情：默认不含已删除记录（已删记录对外视为不存在）
    async get(id, orgId) {
      const rows = await load();
      const r = filterByDeleted(filterByOrg(rows, orgId), false).find((r) => String(r.id) === String(id)) || null;
      return r ? normalizeAudit(r) : null;
    },

    // 详情（含已删除）：回收站「查看 / 恢复 / 彻底删除」前取记录用
    async getByIdIncludeDeleted(id, orgId) {
      const rows = await load();
      const r = filterByOrg(rows, orgId).find((r) => String(r.id) === String(id)) || null;
      return r ? normalizeAudit(r) : null;
    },

    async create(data) {
      const rows = await load();
      const nextId = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
      const now = new Date().toISOString();
      const rec = {
        id: nextId,
        // 机构归属（v1.18）：由路由层注入当前机构；缺省落默认机构
        org_id: data.org_id == null ? DEFAULT_ORG_ID : Number(data.org_id),
        title: data.title,
        department: data.department,
        reporter: data.reporter,
        contact: data.contact || '',
        type: data.type,
        severity: data.severity,
        status: data.status || '待处理',
        description: data.description,
        handler: data.handler || '',
        registrar: data.registrar || '',
        softwareSystem: data.softwareSystem || '',
        resolution: data.resolution || '',
        attachments: Array.isArray(data.attachments) ? data.attachments : [],
        createdBy: data.createdBy || '',          // 由服务端注入登录账号
        audit_status: '待审核',                    // 审核字段：新登记一律待审核，编辑不可改
        audit_reason: '',
        audit_by: '',
        audit_at: null,
        satisfaction: data.satisfaction || '',     // ''=未回访
        feedback: data.feedback || '',
        rated_at: null,
        created_at: now,
        updated_at: now,
        resolved_at: data.status === '已解决' || data.status === '已关闭' ? now : null,
        deleted_at: null,          // 回收站（v1.6 软删除）：null=正常，非空=已入回收站
      };
      rows.push(rec);
      await save(rows);
      return rec;
    },

    async update(id, data, orgId) {
      const rows = await load();
      const idx = rows.findIndex((r) => String(r.id) === String(id) && inOrg(r, orgId));
      if (idx === -1) return null;
      const cur = normalizeAudit(rows[idx]);
      // 审核字段只允许走审核接口维护，编辑接口一律忽略
      const safe = { ...data };
      delete safe.audit_status; delete safe.audit_reason; delete safe.audit_by; delete safe.audit_at;
      const merged = { ...cur, ...safe, updated_at: new Date().toISOString() };
      if (data.status === '已解决' || data.status === '已关闭') {
        merged.resolved_at = cur.resolved_at || new Date().toISOString();
      } else if (data.status && data.status !== '已解决' && data.status !== '已关闭') {
        merged.resolved_at = null;
      }
      // 回访打分：有满意度则记时，清空满意度则一并清空时间
      if ('satisfaction' in data) {
        merged.rated_at = data.satisfaction ? new Date().toISOString() : null;
      }
      rows[idx] = merged;
      await save(rows);
      return merged;
    },

    // 审核：仅覆写 4 个审核字段（允许重复审核覆盖），其余字段不动
    async audit(id, patch = {}, orgId) {
      const rows = await load();
      const idx = rows.findIndex((r) => String(r.id) === String(id) && inOrg(r, orgId));
      if (idx === -1) return null;
      const rec = normalizeAudit(rows[idx]);
      rec.audit_status = patch.audit_status;
      rec.audit_reason = patch.audit_reason || '';
      rec.audit_by = patch.audit_by || '';
      rec.audit_at = patch.audit_at || new Date().toISOString();
      rec.updated_at = new Date().toISOString();
      rows[idx] = rec;
      await save(rows);
      return rec;
    },

    // 软删除（v1.6 回收站）：置 deleted_at，不真删；返回受影响行数（1/0）
    async softRemove(id, orgId) {
      const rows = await load();
      const idx = rows.findIndex((r) => String(r.id) === String(id) && !r.deleted_at && inOrg(r, orgId));
      if (idx === -1) return 0;
      const now = new Date().toISOString();
      rows[idx].deleted_at = now;
      rows[idx].updated_at = now;
      await save(rows);
      return 1;
    },

    // 从回收站恢复：清空 deleted_at；返回受影响行数（1/0）
    async restore(id, orgId) {
      const rows = await load();
      const idx = rows.findIndex((r) => String(r.id) === String(id) && r.deleted_at && inOrg(r, orgId));
      if (idx === -1) return 0;
      rows[idx].deleted_at = null;
      rows[idx].updated_at = new Date().toISOString();
      await save(rows);
      return 1;
    },

    // 彻底删除（真删）：返回被删记录的 { id, attachments }，调用方据此清理附件磁盘文件
    async hardRemove(id, orgId) {
      const rows = await load();
      const idx = rows.findIndex((r) => String(r.id) === String(id) && inOrg(r, orgId));
      if (idx === -1) return null;
      const rec = rows[idx];
      rows.splice(idx, 1);
      await save(rows);
      return { id: rec.id, attachments: Array.isArray(rec.attachments) ? rec.attachments : [] };
    },

    // 批量改状态：一次写盘，返回实际更新条数
    async bulkUpdateStatus(ids = [], status, orgId) {
      const rows = await load();
      const set = new Set(ids.map(String));
      const now = new Date().toISOString();
      let updated = 0;
      for (const r of rows) {
        if (!set.has(String(r.id)) || !inOrg(r, orgId)) continue;
        r.status = status;
        r.updated_at = now;
        if (status === '已解决' || status === '已关闭') r.resolved_at = r.resolved_at || now;
        else r.resolved_at = null;
        updated++;
      }
      if (updated) await save(rows);
      return updated;
    },

    // 批量软删除（v1.6 回收站）：仅对未删除记录置 deleted_at；
    // 返回被软删的记录（含附件元数据，供「彻底删除」时参考），不清理磁盘文件（恢复后附件仍可用）。
    async bulkRemove(ids = [], orgId) {
      const rows = await load();
      const set = new Set(ids.map(String));
      const now = new Date().toISOString();
      const removed = [];
      for (const r of rows) {
        if (!set.has(String(r.id)) || r.deleted_at || !inOrg(r, orgId)) continue;
        r.deleted_at = now;
        r.updated_at = now;
        removed.push(r);
      }
      if (removed.length) await save(rows);
      return removed.map((r) => ({ id: r.id, attachments: Array.isArray(r.attachments) ? r.attachments : [] }));
    },

    async stats(orgId) {
      const rows = await load();
      // 统计口径：不含回收站记录
      const active = filterByDeleted(filterByOrg(rows, orgId), false);
      return {
        total: active.length,
        byStatus: groupCount(active, 'status'),
        byType: groupCount(active, 'type'),
        byDepartment: groupCount(active, 'department'),
        bySatisfaction: groupCount(active, 'satisfaction'),
      };
    },

    async exportRows({ status, type, department, keyword, auditStatus, deleted, sort, order, orgId } = {}) {
      const rows = await load();
      // 导出：默认仅未删除记录（回收站数据不进报表）
      const scoped = filterByOrg(rows, orgId);
      const active = applyFilters(filterByDeleted(scoped, deleted), { status, type, department, keyword, auditStatus });
      return sortRows(active, sort, order).map(normalizeAudit);
    },
    async trend(orgId) {
      const rows = await load();
      const active = filterByDeleted(filterByOrg(rows, orgId), false);
      return {
        byDepartment: Object.entries(groupCount(active, 'department'))
          .map(([department, count]) => ({ department, count }))
          .sort((a, b) => b.count - a.count),
        byMonth: groupByMonth(active),
      };
    },

    // 数据驾驶舱：多维度统计（与 mssql 侧共用 computeDashboard，保证口径一致）
    async dashboard(orgId) {
      const rows = await load();
      // 驾驶舱口径：不含回收站记录
      return computeDashboard(filterByDeleted(filterByOrg(rows, orgId), false), new Date());
    },
  };
}
