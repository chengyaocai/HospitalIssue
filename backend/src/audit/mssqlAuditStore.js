import sql from 'mssql';

// 生产用：SQL Server 审计日志表。
export function createMssqlAuditStore(cfg) {
  let pool;
  async function getPool() {
    if (!pool) {
      pool = await new sql.ConnectionPool(cfg).connect();
      await initTable();
    }
    return pool;
  }
  async function initTable() {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'audit_log')
      BEGIN
        CREATE TABLE dbo.audit_log (
          id BIGINT IDENTITY(1,1) PRIMARY KEY,
          username NVARCHAR(50),
          action NVARCHAR(50),
          target NVARCHAR(100),
          detail NVARCHAR(MAX),
          created_at DATETIME NOT NULL DEFAULT GETDATE()
        );
        CREATE INDEX ix_audit_log_time ON dbo.audit_log(created_at);
      END
    `);
    // 多机构（v1.18 增量迁移）：日志归属机构，默认 1（默认机构）。
    try {
      await pool.request().query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.audit_log') AND name = N'org_id') ALTER TABLE dbo.audit_log ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;`);
    } catch { /* 容忍列已存在等情况 */ }
  }

  function buildWhere(req, f = {}) {
    const c = [];
    // 多机构（v1.18）行级隔离：只在显式传入 orgId 时施加
    if (f.orgId != null) { c.push('org_id=@org'); req.input('org', sql.BigInt, f.orgId); }
    if (f.action) { c.push('action=@action'); req.input('action', sql.NVarChar(50), f.action); }
    if (f.username) { c.push('username=@username'); req.input('username', sql.NVarChar(50), f.username); }
    if (f.from) { c.push('created_at >= @from'); req.input('from', sql.DateTime, new Date(f.from)); }
    if (f.to) {
      // 若为纯日期，取当日结束（+1 天后用 < 比较）
      const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(f.to))
        ? new Date(new Date(f.to).getTime() + 24 * 60 * 60 * 1000)
        : new Date(f.to);
      c.push('created_at < @to');
      req.input('to', sql.DateTime, toDate);
    }
    return c.length ? 'WHERE ' + c.join(' AND ') : '';
  }

  const map = (r) => ({
    id: r.id, org_id: r.org_id == null ? 1 : Number(r.org_id),
    username: r.username, action: r.action, target: r.target,
    detail: r.detail, created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  });

  return {
    async add(entry) {
      const p = await getPool();
      const req = p.request();
      // 机构归属（v1.18）：缺省落默认机构
      req.input('org', sql.BigInt, entry.org_id == null ? 1 : Number(entry.org_id));
      req.input('username', sql.NVarChar(50), entry.username || '');
      req.input('action', sql.NVarChar(50), entry.action || '');
      req.input('target', sql.NVarChar(100), entry.target || null);
      req.input('detail', sql.NVarChar(sql.MAX), entry.detail || null);
      const res = await req.query('INSERT INTO dbo.audit_log (org_id,username,action,target,detail) OUTPUT INSERTED.* VALUES (@org,@username,@action,@target,@detail)');
      return map(res.recordset[0]);
    },
    async list({ action, username, from, to, page = 1, pageSize = 50, orgId } = {}) {
      const p = await getPool();
      const where = buildWhere(p.request(), { action, username, from, to, orgId });
      const totalReq = p.request();
      buildWhere(totalReq, { action, username, from, to, orgId });
      const totalRes = await totalReq.query(`SELECT COUNT(*) AS c FROM dbo.audit_log ${where}`);
      const total = totalRes.recordset[0].c;
      const req = p.request();
      buildWhere(req, { action, username, from, to, orgId });
      req.input('offset', sql.Int, (Number(page) - 1) * Number(pageSize));
      req.input('limit', sql.Int, Number(pageSize));
      const res = await req.query(`SELECT * FROM dbo.audit_log ${where} ORDER BY created_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`);
      return { rows: res.recordset.map(map), total };
    },
    async exportRows({ action, username, from, to, orgId } = {}) {
      const p = await getPool();
      const req = p.request();
      const where = buildWhere(req, { action, username, from, to, orgId });
      const res = await req.query(`SELECT * FROM dbo.audit_log ${where} ORDER BY created_at DESC`);
      return res.recordset.map(map);
    },
  };
}
