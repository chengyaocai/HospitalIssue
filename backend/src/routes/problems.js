import express from 'express';
import { getRepo } from '../db/index.js';
import { validateCreate, validateUpdate, validateSatisfaction, STATUSES, SATISFACTIONS } from '../validators.js';
import { EXPORT_COLUMNS } from '../services/export.js';
import { toCSV, toXLSX, describeConditions, toDraftXLSX, buildDraftRecord } from '../services/export.js';
import { removeStoredFiles } from '../services/uploads.js';
import { authenticate } from '../auth/middleware.js';
import { requirePermission } from '../auth/authorize.js';
import { getSettings } from '../settings/index.js';
import { permissionsFor } from '../permissions.js';
import { audit } from '../audit/index.js';
import { getUserStore } from '../auth/index.js';
import { getOrgStore } from '../orgs/index.js';
import { sendNotification } from '../notifications/index.js';
import { send500 } from '../errors.js';

const router = express.Router();

// 批量操作单次上限，防止超大请求
const MAX_BULK = 200;

function normalizeIds(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const v of input) {
    const id = Number(v);
    if (Number.isFinite(id) && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

// v1.18.26 防御性 id 解析：仅接受「十进制正整数（safe integer）」字符串。
// 背景：旧部署缺 export-draft 等路由时，/problems/export-draft 会落到
// GET /problems/:id，非数字字符串被直接绑定进 mssql BigInt 参数而打出 500 堆栈
// （dev 存储不做数字校验，测试环境从未暴露）。此处统一提前拦截：
// 非法 id 一律按 404「问题不存在」处理，合法路径行为完全不变。
// 仅匹配 /^\d+$/：拒绝 'abc'、'12abc'、'-1'、'1e3'（科学计数法）、小数、'0'。
function parseIdParam(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// 统一 500 出口：原始错误只进日志，对外一律中文（复用全局 errors.js）
const fail = send500;

// 健康检查公开（无需登录）
router.get('/health', (req, res) => res.json({ ok: true, driver: process.env.DB_DRIVER || 'mssql' }));

// 除登录/健康检查外，所有问题接口均需登录
router.use(authenticate);

// 筛选多值（v1.18.45）：status / type / department 支持「逗号分隔多值」（如 status=待处理,处理中）。
// 单值完全向后兼容；上限 50 个（防御超长 URL），空段丢弃，全空回落 undefined=不过滤。
function splitMulti(v) {
  if (!v) return undefined;
  const arr = String(v).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  return arr.length ? arr : undefined;
}

function parseQuery(q) {
  return {
    status: splitMulti(q.status),
    auditStatus: q.auditStatus || undefined,
    type: splitMulti(q.type),
    department: splitMulti(q.department),
    keyword: q.keyword || undefined,
    // 回收站（v1.6 软删除）：deleted=1 查回收站；默认查正常列表
    deleted: q.deleted === '1' ? true : undefined,
    // 排序：字段与方向均会经仓储层白名单归一化（非法值回落 created_at desc）
    sort: q.sort || undefined,
    order: q.order || undefined,
    page: q.page ? Number(q.page) : 1,
    pageSize: q.pageSize ? Number(q.pageSize) : 20,
  };
}

// 回收站可见性（v1.6）：软删列表 / 已删详情仅对具备「删除问题」权限的角色开放（与软删操作同权限）。
async function canSeeDeleted(user, orgId) {
  const { permissions } = await getSettings(orgId);
  return permissionsFor(permissions, user.role).actions['issue.delete'] === true;
}

router.get('/problems', async (req, res) => {
  try {
    const query = parseQuery(req.query);
    if (query.deleted && !(await canSeeDeleted(req.user, req.orgId))) {
      return res.status(403).json({ error: '仅具备「删除问题」权限的角色可查看回收站' });
    }
    const repo = await getRepo();
    res.json(await repo.list({ ...query, orgId: req.orgId }));
  } catch (e) {
    fail(res, e);
  }
});

router.get('/problems/stats', async (req, res) => {
  try {
    const repo = await getRepo();
    res.json(await repo.stats(req.orgId));
  } catch (e) {
    fail(res, e);
  }
});

router.get('/problems/export', requirePermission('issue.export'), async (req, res) => {
  try {
    const repo = await getRepo();
    const format = (req.query.format || 'xlsx').toLowerCase();
    const query = parseQuery(req.query);
    delete query.deleted;   // 导出始终导正常数据，不受回收站视图影响
    const rows = await repo.exportRows({ ...query, orgId: req.orgId });
    // 字段白名单：只接受 export.js 中定义的列 key，非法项直接丢弃
    const allowed = new Set(EXPORT_COLUMNS.map((c) => c.key));
    let fields = req.query.fields;
    if (fields === undefined || fields === null || fields === '') fields = [];
    else if (!Array.isArray(fields)) fields = [fields];
    const chosen = fields.filter((f) => allowed.has(String(f)));
    const columns = chosen.length ? EXPORT_COLUMNS.filter((c) => chosen.includes(c.key)) : EXPORT_COLUMNS;
    const conditions = describeConditions(req.query, rows.length, {
      exportedBy: req.user.username,
      fields: columns.map((c) => c.header),
    });
    const meta = { conditions, columns };
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="software_issues.csv"');
      res.send(toCSV(rows, meta));
    } else {
      const buf = await toXLSX(rows, meta);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="software_issues.xlsx"');
      res.send(buf);
    }
  } catch (e) {
    fail(res, e);
  }
});

// v1.18.24：底稿登记清单导出（「审核通过」菜单用）——
// 仅导出 audit_status='已通过' 的问题（与该视图口径一致），支持 keyword（标题/科室/提出人/登记人），
// 不分页导出全部，按审核时间倒序；生成含「底稿登记清单 + 登记要点」两个 sheet 的 xlsx，
// 供信息科到卫宁底稿系统登记底稿。注意：必须定义在 /problems/:id 之前。
router.get('/problems/export-draft', requirePermission('issue.export'), async (req, res) => {
  try {
    const repo = await getRepo();
    const keyword = String(req.query.keyword || '').trim() || undefined;
    const rows = await repo.exportRows({
      auditStatus: '已通过',
      keyword,
      sort: 'audit_at',
      order: 'desc',
      orgId: req.orgId,
    });
    // 空结果显式报错，前端据此提示，避免用户拿到一个只有表头的空文件误以为导出成功
    if (!rows.length) {
      return res.status(400).json({ error: '当前没有已通过的问题可导出' });
    }
    // 「医院」列取当前机构名称作参考（hospitalId 需人工在底稿系统确认）
    const orgStore = await getOrgStore();
    const org = await orgStore.get(req.orgId);
    const buf = await toDraftXLSX(rows.map((r) => buildDraftRecord(r, (org && org.name) || '')));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="draft_register.xlsx"');
    res.send(buf);
  } catch (e) {
    fail(res, e);
  }
});

// 趋势聚合（按科室 + 按月度），用于前端小图
router.get('/problems/trend', async (req, res) => {
  try {
    const repo = await getRepo();
    res.json(await repo.trend(req.orgId));
  } catch (e) {
    fail(res, e);
  }
});

// 运维知识库（v1.18.27）：所有写了处理说明的问题自动收录，派生视图、只读。
// 登录即可访问；菜单显隐由权限矩阵 menus 控制（与 GET /problems 同一鉴权级别）。
// 注意：必须定义在 /problems/:id 之前（parseIdParam 依赖路由顺序）。
router.get('/problems/kb', async (req, res) => {
  try {
    const repo = await getRepo();
    const q = req.query;
    const page = q.page ? Math.max(1, Number(q.page) || 1) : 1;
    const pageSize = q.pageSize ? Math.min(100, Math.max(1, Number(q.pageSize) || 20)) : 20;
    res.json(await repo.listKb({
      keyword: q.keyword || undefined,
      type: q.type || undefined,
      sort: q.sort || 'updated_at',
      order: q.order || 'desc',
      page, pageSize, orgId: req.orgId,
    }));
  } catch (e) { fail(res, e); }
});

// 数据驾驶舱：多维度统计（与 /stats 同级，无需额外权限，仅需登录）。
// 注意：必须定义在 /problems/:id 之前。
router.get('/problems/dashboard', async (req, res) => {
  try {
    const repo = await getRepo();
    res.json(await repo.dashboard(req.orgId));
  } catch (e) {
    fail(res, e);
  }
});

// ---- 批量操作（注意：必须定义在 /problems/:id 之前）----

// 批量改状态：需「批量改状态」功能权限
router.post('/problems/bulk/status', requirePermission('issue.bulkStatus'), async (req, res) => {
  try {
    const ids = normalizeIds(req.body?.ids);
    if (!ids.length) return res.status(400).json({ error: '未选择任何问题' });
    if (ids.length > MAX_BULK) return res.status(400).json({ error: `一次最多处理 ${MAX_BULK} 条` });
    const status = String(req.body?.status || '');
    if (!STATUSES.includes(status)) return res.status(400).json({ error: '状态取值不合法' });
    const repo = await getRepo();
    const updated = await repo.bulkUpdateStatus(ids, status, req.orgId);
    await audit({
      username: req.user.username,
      action: 'BULK_UPDATE_STATUS',
      target: `problem#${ids.slice(0, 20).join(',')}${ids.length > 20 ? '…' : ''}`,
      detail: `批量改状态 -> ${status}，成功 ${updated} 条`,
    });
    res.json({ ok: true, updated });
  } catch (e) {
    fail(res, e);
  }
});

// 批量删除（v1.6 改为软删除，移入回收站；磁盘附件保留，彻底删除时才清理）
router.post('/problems/bulk/delete', requirePermission('issue.bulkDelete'), async (req, res) => {
  try {
    const ids = normalizeIds(req.body?.ids);
    if (!ids.length) return res.status(400).json({ error: '未选择任何问题' });
    if (ids.length > MAX_BULK) return res.status(400).json({ error: `一次最多处理 ${MAX_BULK} 条` });
    const repo = await getRepo();
    const removed = await repo.bulkRemove(ids, req.orgId);
    await audit({
      username: req.user.username,
      action: 'BULK_DELETE_ISSUE',
      target: `problem#${ids.slice(0, 20).join(',')}${ids.length > 20 ? '…' : ''}`,
      detail: `批量删除 ${removed.length} 条，已移入回收站`,
    });
    res.json({ ok: true, deleted: removed.length });
  } catch (e) {
    fail(res, e);
  }
});

// 详情：已删记录默认 404；?deleted=1（且具备删除权限）可查看回收站记录
router.get('/problems/:id', async (req, res) => {
  try {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(404).json({ error: '问题不存在' });
    const repo = await getRepo();
    let rec;
    if (req.query.deleted === '1') {
      if (!(await canSeeDeleted(req.user, req.orgId))) {
        return res.status(403).json({ error: '仅具备「删除问题」权限的角色可查看回收站记录' });
      }
      rec = await repo.getByIdIncludeDeleted(id, req.orgId);
    } else {
      rec = await repo.get(id, req.orgId);
    }
    if (!rec) return res.status(404).json({ error: '未找到该问题' });
    res.json(rec);
  } catch (e) {
    fail(res, e);
  }
});

// 问题回访 / 满意度打分：需「问题回访」功能权限，且满足下列之一：
// - 具备「回访全部问题」权限（issue.rateAll，替代原 isAdmin 硬编码）；
// - 为该问题登记人本人；
// - 老数据无 createdBy（保证历史数据可用）。
router.post('/problems/:id/satisfaction', requirePermission('issue.rate'), async (req, res) => {
  try {
    const { ok, errors, value } = validateSatisfaction(req.body || {});
    if (!ok) return res.status(400).json({ error: errors.join('; ') });
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(404).json({ error: '问题不存在' });
    const repo = await getRepo();
    const rec = await repo.get(id, req.orgId);
    if (!rec) return res.status(404).json({ error: '未找到该问题' });
    const isOwn = rec.createdBy && rec.createdBy === req.user.username;
    const isLegacy = !rec.createdBy;
    const { permissions } = await getSettings(req.orgId);
    const canRateAll = permissionsFor(permissions, req.user.role).actions['issue.rateAll'] === true;
    if (!isOwn && !isLegacy && !canRateAll) {
      return res.status(403).json({ error: '仅登记人本人或具备回访全部权限的角色可对该问题进行回访打分' });
    }
    const updated = await repo.update(id, value, req.orgId);
    const detail = value.satisfaction
      ? `回访满意度=${value.satisfaction}${value.feedback ? '，备注：' + value.feedback : ''}`
      : '清空回访记录';
    await audit({ username: req.user.username, action: 'RATE_SATISFACTION', target: 'problem#' + id, detail });
    res.json(updated);
  } catch (e) {
    fail(res, e);
  }
});

// 审核结果站内通知（v1.18.25，由 notifyRegistrar 扩展而来）：
// - 收件人集合 = ①登记人：优先 createdBy（登录账号）；老数据无 createdBy 时按
//   registrar 姓名/账号在用户花名册中反查；②提出人：rec.reporter 为自由文本姓名，
//   同样按姓名/账号在花名册中精确匹配反查（有对应账号才发）。
// - 同一账号只发一条（登记人与提出人为同一人时去重）。
// - 审核人本人（from）也在收件人内照发：自己审核自己登记的问题收到通知无害，
//   且能确认审核已生效，不做特殊跳过。
// - orgId 必传：通知必须归属「审核发生时所在的机构」。缺省时存储层会把通知落到
//   默认机构 1（见 devNotificationStore / mssqlNotificationStore），导致非默认机构
//   （如妇保医院）的登记人永远收不到 —— 这是 v1.18 多机构改造的回归缺陷主因。
// - 找不到任何可通知账号则静默跳过，绝不影响审核本身。
async function notifyAuditResult(rec, title, body, from, orgId) {
  try {
    const users = await (await getUserStore()).list();
    const to = new Set();
    // ① 登记人：优先登录账号；老数据按 registrar 姓名/账号反查
    if (rec.createdBy) {
      to.add(rec.createdBy);
    } else if (rec.registrar) {
      const hit = users.find((u) => u.username === rec.registrar || u.name === rec.registrar);
      if (hit) to.add(hit.username);
    }
    // ② 提出人：reporter 为自由文本，按姓名/账号在花名册中反查
    if (rec.reporter) {
      const hit = users.find((u) => u.username === rec.reporter || u.name === rec.reporter);
      if (hit) to.add(hit.username);
    }
    if (!to.size) return;
    await sendNotification({ title, body, from, to: [...to], orgId });
  } catch (e) {
    console.error('[problems] 审核通知发送失败：', e && e.message ? e.message : e);
  }
}

// 审核问题：需「审核问题」功能权限。
// 规则：通过无需原因；不通过必须填写原因；允许重复审核（覆盖上一次结果）。
router.post('/problems/:id/audit', requirePermission('issue.audit'), async (req, res) => {
  try {
    const result = String(req.body?.result || '');
    if (result !== 'approve' && result !== 'reject') {
      return res.status(400).json({ error: '审核结果不合法，须为 approve 或 reject' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (result === 'reject' && !reason) {
      return res.status(400).json({ error: '请填写不通过原因' });
    }
    if (result === 'reject' && reason.length > 200) {
      return res.status(400).json({ error: '不通过原因不能超过 200 字' });
    }
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(404).json({ error: '问题不存在' });
    const repo = await getRepo();
    const rec = await repo.get(id, req.orgId);
    if (!rec) return res.status(404).json({ error: '问题不存在' });
    const approved = result === 'approve';
    const auditBy = req.user.name || req.user.username;
    const updated = await repo.audit(id, {
      audit_status: approved ? '已通过' : '不通过',
      audit_reason: approved ? '' : reason,
      audit_by: auditBy,
      audit_at: new Date().toISOString(),
    }, req.orgId);
    const title = approved ? '问题审核通过' : '问题审核不通过';
    const body = `「${rec.title}」${approved ? '已通过审核' : `未通过审核：${reason}`}（审核人：${auditBy}）`;
    // v1.18.25：必须传当前机构 id —— 通知与审核同机构，非默认机构的登记人才能收到
    await notifyAuditResult(rec, title, body, req.user.username, req.orgId);
    await audit({
      username: req.user.username,
      action: approved ? 'APPROVE_ISSUE' : 'REJECT_ISSUE',
      target: 'problem#' + id,
      detail: approved ? '审核通过' : `审核不通过：${reason}`,
    });
    res.json(updated);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/problems', requirePermission('issue.create'), async (req, res) => {
  try {
    const { ok, errors, value } = validateCreate(req.body);
    if (!ok) return res.status(400).json({ error: errors.join('; ') });
    const repo = await getRepo();
    // createdBy 由服务端从登录态注入，绝不信任前端传值；org_id 同理（当前机构）
    const rec = await repo.create({ ...value, createdBy: req.user.username, org_id: req.orgId });
    await audit({ username: req.user.username, action: 'CREATE_ISSUE', target: 'problem#' + rec.id, detail: rec.title });
    res.status(201).json(rec);
  } catch (e) {
    fail(res, e);
  }
});

router.put('/problems/:id', requirePermission('issue.edit'), async (req, res) => {
  try {
    const { ok, errors, value } = validateUpdate(req.body);
    if (!ok) return res.status(400).json({ error: errors.join('; ') });
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(404).json({ error: '问题不存在' });
    const repo = await getRepo();
    const rec = await repo.update(id, value, req.orgId);
    if (!rec) return res.status(404).json({ error: '未找到该问题' });
    await audit({ username: req.user.username, action: 'UPDATE_ISSUE', target: 'problem#' + id, detail: JSON.stringify(value) });
    res.json(rec);
  } catch (e) {
    fail(res, e);
  }
});

// 删除问题（v1.6 改为软删除，移入回收站；权限不变 issue.delete，磁盘附件保留）
router.delete('/problems/:id', requirePermission('issue.delete'), async (req, res) => {
  try {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(404).json({ error: '问题不存在' });
    const repo = await getRepo();
    const rec = await repo.get(id, req.orgId);
    if (!rec) return res.status(404).json({ error: '未找到该问题' });
    const affected = await repo.softRemove(id, req.orgId);
    if (!affected) return res.status(404).json({ error: '未找到该问题' });
    await audit({
      username: req.user.username,
      action: 'DELETE_ISSUE',
      target: 'problem#' + id,
      detail: `已移入回收站：${rec.title}`,
    });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// 从回收站恢复（v1.6）：清空 deleted_at，问题回到正常列表
router.post('/problems/:id/restore', requirePermission('issue.delete'), async (req, res) => {
  try {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(404).json({ error: '问题不存在' });
    const repo = await getRepo();
    const rec = await repo.getByIdIncludeDeleted(id, req.orgId);
    if (!rec) return res.status(404).json({ error: '未找到该问题' });
    const affected = await repo.restore(id, req.orgId);
    if (!affected) return res.status(400).json({ error: '该问题不在回收站中，无需恢复' });
    await audit({
      username: req.user.username,
      action: 'RESTORE_ISSUE',
      target: 'problem#' + id,
      detail: `从回收站恢复：${rec.title}`,
    });
    const restored = await repo.get(id, req.orgId);
    res.json(restored);
  } catch (e) {
    fail(res, e);
  }
});

// 彻底删除（v1.6）：真删 + 清理磁盘附件文件，不可恢复
router.delete('/problems/:id/hard', requirePermission('issue.delete'), async (req, res) => {
  try {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(404).json({ error: '问题不存在' });
    const repo = await getRepo();
    const rec = await repo.getByIdIncludeDeleted(id, req.orgId);
    if (!rec) return res.status(404).json({ error: '未找到该问题' });
    const removed = await repo.hardRemove(id, req.orgId);
    if (!removed) return res.status(404).json({ error: '未找到该问题' });
    const filesRemoved = await removeStoredFiles(removed.attachments);
    await audit({
      username: req.user.username,
      action: 'PURGE_ISSUE',
      target: 'problem#' + id,
      detail: `彻底删除（不可恢复）：${rec.title}${filesRemoved ? `，清理 ${filesRemoved} 个附件文件` : ''}`,
    });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

export default router;
