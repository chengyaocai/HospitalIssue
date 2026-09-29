import express from 'express';
import { authenticate } from '../auth/middleware.js';
import { requirePermission } from '../auth/authorize.js';
import { getAuditStore } from '../audit/index.js';
import { auditToCSV, auditToXLSX } from '../services/export.js';
import { send500 } from '../errors.js';

const router = express.Router();

// 仅具备「查看操作日志」权限的角色可查看审计日志
router.use(authenticate, requirePermission('audit.view'));

function parseQuery(q) {
  return {
    action: q.action || undefined,
    username: q.username || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    page: q.page ? Number(q.page) : 1,
    pageSize: q.pageSize ? Number(q.pageSize) : 50,
  };
}

router.get('/', async (req, res) => {
  try {
    const store = await getAuditStore();
    res.json(await store.list({ ...parseQuery(req.query), orgId: req.orgId }));
  } catch (e) {
    send500(res, e);
  }
});

router.get('/export', async (req, res) => {
  try {
    const format = (req.query.format || 'xlsx').toLowerCase();
    const store = await getAuditStore();
    const rows = await store.exportRows({ ...parseQuery(req.query), orgId: req.orgId });
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="audit_log.csv"');
      res.send(auditToCSV(rows));
    } else {
      const buf = await auditToXLSX(rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="audit_log.xlsx"');
      res.send(buf);
    }
  } catch (e) {
    send500(res, e);
  }
});

export default router;
