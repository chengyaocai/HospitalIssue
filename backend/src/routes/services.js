import express from 'express';
import { getSvcStore } from '../svcmanage/index.js';
import { SVC_TYPES, SVC_ENVS } from '../svcmanage/constants.js';
import { authenticate } from '../auth/middleware.js';
import { requirePermission } from '../auth/authorize.js';
import { audit } from '../audit/index.js';
import { send500 } from '../errors.js';

const router = express.Router();

// ── 业务服务管理（v1.18.82）──
// 登记医院各系统/服务的地址、账号、密码、路径、用途等信息，方便查询管理。
// 查看对任何登录用户开放（有菜单权限即可见，口径同值班表）；
// 新增/编辑/删除为功能权限 service.manage（服务维护）。
// 数据按机构隔离（org_id）：跨机构一律 404，不暴露存在性。

function str(v, max) {
  const s = String(v ?? '').trim();
  return max ? s.slice(0, max) : s;
}

// 从请求体取服务字段并做基础校验，返回 { error } 或字段对象。
function parseBody(body) {
  const name = str(body.name, 255);
  if (!name) return { error: '请填写服务名称' };
  const remark = str(body.remark, 500);
  if (!remark) return { error: '请填写备注（用途、端口、依赖、联系人等）' };
  return {
    name,
    svc_type: str(body.svc_type, 50) || '未指定',
    hospital: str(body.hospital, 255),
    vendor: str(body.vendor, 255),
    username: str(body.username, 255),
    password: str(body.password, 255),
    env: str(body.env, 32) || '未指定',
    sort: Number(body.sort) || 0,
    url: str(body.url, 1000),
    path: str(body.path, 1000),
    remark,
    enabled: body.enabled === false ? false : true,
  };
}

// 列表 + 元信息：q（名称/医院/厂家/账号/地址/路径/备注模糊）、type、env、enabled、page、pageSize。
// types / envs 随响应下发，前端下拉同源渲染（同 files.categories 模式）。
router.get('/', authenticate, async (req, res) => {
  try {
    const store = await getSvcStore();
    const result = await store.list({
      q: req.query.q ? String(req.query.q) : '',
      type: req.query.type ? String(req.query.type) : '',
      env: req.query.env ? String(req.query.env) : '',
      enabled: req.query.enabled === '1' ? true : req.query.enabled === '0' ? false : undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 50,
      orgId: req.orgId,
    });
    res.json({ ...result, types: SVC_TYPES, envs: SVC_ENVS });
  } catch (e) {
    send500(res, e);
  }
});

// 以下写操作均需「服务维护」功能权限（authenticate 必须先于鉴权注入 req.user / req.orgId）。
router.use(authenticate, requirePermission('service.manage'));

// 新增服务
router.post('/', async (req, res) => {
  try {
    const parsed = parseBody(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const store = await getSvcStore();
    const rec = await store.create({ ...parsed, org_id: req.orgId, created_by: req.user.username });
    await audit({
      username: req.user.username,
      action: 'CREATE_SERVICE',
      target: parsed.name,
      detail: `新增业务服务（${parsed.svc_type} / ${parsed.env}）`,
    });
    res.status(201).json(rec);
  } catch (e) {
    send500(res, e);
  }
});

// 编辑服务（全量字段覆盖式提交；不做局部 patch，前端弹窗整单提交）
router.put('/:id', async (req, res) => {
  try {
    const store = await getSvcStore();
    const before = await store.getById(req.params.id, req.orgId);
    if (!before) return res.status(404).json({ error: '服务不存在或已被删除' });
    const parsed = parseBody(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const rec = await store.update(req.params.id, req.orgId, parsed);
    await audit({
      username: req.user.username,
      action: 'UPDATE_SERVICE',
      target: parsed.name,
      detail: `编辑业务服务「${before.name}」`,
    });
    res.json(rec);
  } catch (e) {
    send500(res, e);
  }
});

// 删除服务
router.delete('/:id', async (req, res) => {
  try {
    const store = await getSvcStore();
    const removed = await store.remove(req.params.id, req.orgId);
    if (!removed) return res.status(404).json({ error: '服务不存在或已被删除' });
    await audit({
      username: req.user.username,
      action: 'DELETE_SERVICE',
      target: removed.name,
      detail: `删除业务服务「${removed.name}」`,
    });
    res.json({ ok: true });
  } catch (e) {
    send500(res, e);
  }
});

export default router;
