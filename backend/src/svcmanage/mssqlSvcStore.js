import sql from 'mssql';
import { DEFAULT_ORG_ID } from '../db/orgScope.js';
import { normalizeSvcType, normalizeSvcEnv } from './constants.js';

// 生产用：SQL Server 业务服务管理（dbo.app_service，v1.18.82）。
// 所有查询都带 org_id 过滤（多机构红线：跨机构一律视为不存在）。
export function createMssqlSvcStore(cfg) {
  let pool;
  async function getPool() {
    if (!pool) {
      pool = await new sql.ConnectionPool(cfg).connect();
      await initTable();
    }
    return pool;
  }
  // 启动时自动建表（若不存在）：与 schema.sql 第 12 节保持一致，正常升级无需手工执行 SQL。
  async function initTable() {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_service')
      BEGIN
        CREATE TABLE dbo.app_service (
          id         BIGINT IDENTITY(1,1) PRIMARY KEY,
          org_id     BIGINT NOT NULL DEFAULT 1,
          name       NVARCHAR(255) NOT NULL,
          svc_type   NVARCHAR(50)  NOT NULL DEFAULT N'未指定',
          hospital   NVARCHAR(255) NOT NULL DEFAULT N'',
          vendor     NVARCHAR(255) NOT NULL DEFAULT N'',
          username   NVARCHAR(255) NOT NULL DEFAULT N'',
          password   NVARCHAR(255) NOT NULL DEFAULT N'',
          env        NVARCHAR(32)  NOT NULL DEFAULT N'未指定',
          sort       INT NOT NULL DEFAULT 0,
          url        NVARCHAR(1000) NOT NULL DEFAULT N'',
          path       NVARCHAR(1000) NOT NULL DEFAULT N'',
          remark     NVARCHAR(500) NOT NULL DEFAULT N'',
          enabled    BIT NOT NULL DEFAULT 1,
          created_by NVARCHAR(100) NOT NULL DEFAULT N'',
          created_at DATETIME NOT NULL DEFAULT GETDATE(),
          updated_at DATETIME NULL
        );
        CREATE INDEX ix_app_service_org ON dbo.app_service (org_id, sort, id);
      END
    `);
  }

  // 数据库行 -> 统一字段名（与 devSvcStore 完全一致）。
  const map = (r) => ({
    id: r.id,
    org_id: r.org_id == null ? DEFAULT_ORG_ID : Number(r.org_id),
    name: r.name || '',
    svc_type: normalizeSvcType(r.svc_type),
    hospital: r.hospital || '',
    vendor: r.vendor || '',
    username: r.username || '',
    password: r.password || '',
    env: normalizeSvcEnv(r.env),
    sort: r.sort == null ? 0 : Number(r.sort),
    url: r.url || '',
    path: r.path || '',
    remark: r.remark || '',
    enabled: !!r.enabled,
    created_by: r.created_by || '',
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  });

  return {
    async init() { await getPool(); },

    // 列表：当前机构 → 关键字/类型/环境/启用状态过滤 → 序号升序 → 分页 + 总数。
    // q 模糊匹配字段与 devSvcStore.list 一致（名称/医院/厂家/账号/地址/路径/备注）。
    async list({ q, type, env, enabled, page = 1, pageSize = 20, orgId } = {}) {
      const p = await getPool();
      const req = p.request();
      req.input('org', sql.BigInt, orgId == null ? DEFAULT_ORG_ID : Number(orgId));
      let where = 'org_id = @org';
      if (q) {
        req.input('kw', sql.NVarChar(255), `%${q}%`);
        where += " AND (name LIKE @kw OR hospital LIKE @kw OR vendor LIKE @kw OR username LIKE @kw OR url LIKE @kw OR path LIKE @kw OR remark LIKE @kw)";
      }
      if (type) { req.input('type', sql.NVarChar(50), type); where += ' AND svc_type = @type'; }
      if (env) { req.input('env', sql.NVarChar(32), env); where += ' AND env = @env'; }
      if (enabled === true || enabled === false) {
        req.input('enabled', sql.Bit, enabled ? 1 : 0);
        where += ' AND enabled = @enabled';
      }
      const totalRes = await req.query(`SELECT COUNT(*) AS c FROM dbo.app_service WHERE ${where}`);
      const total = Number(totalRes.recordset[0].c) || 0;
      req.input('offset', sql.Int, (Number(page) - 1) * Number(pageSize));
      req.input('limit', sql.Int, Number(pageSize));
      const res = await req.query(
        `SELECT * FROM dbo.app_service WHERE ${where} ORDER BY sort ASC, id ASC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
      );
      return { rows: res.recordset.map(map), total, page: Number(page), pageSize: Number(pageSize) };
    },

    // 按 id 取记录（仅限当前机构；跨机构一律视为不存在 —— 多机构红线）。
    async getById(id, orgId) {
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, num);
      req.input('org', sql.BigInt, orgId == null ? DEFAULT_ORG_ID : Number(orgId));
      const res = await req.query('SELECT * FROM dbo.app_service WHERE id = @id AND org_id = @org');
      return res.recordset.length ? map(res.recordset[0]) : null;
    },

    async create(rec) {
      const p = await getPool();
      const req = p.request();
      req.input('org', sql.BigInt, rec.org_id == null ? DEFAULT_ORG_ID : Number(rec.org_id));
      req.input('name', sql.NVarChar(255), rec.name || '');
      req.input('svc_type', sql.NVarChar(50), normalizeSvcType(rec.svc_type));
      req.input('hospital', sql.NVarChar(255), rec.hospital || '');
      req.input('vendor', sql.NVarChar(255), rec.vendor || '');
      req.input('username', sql.NVarChar(255), rec.username || '');
      req.input('password', sql.NVarChar(255), rec.password || '');
      req.input('env', sql.NVarChar(32), normalizeSvcEnv(rec.env));
      req.input('sort', sql.Int, Number(rec.sort) || 0);
      req.input('url', sql.NVarChar(1000), rec.url || '');
      req.input('path', sql.NVarChar(1000), rec.path || '');
      req.input('remark', sql.NVarChar(500), rec.remark || '');
      req.input('enabled', sql.Bit, rec.enabled === false ? 0 : 1);
      req.input('created_by', sql.NVarChar(100), rec.created_by || '');
      const res = await req.query(`
        INSERT INTO dbo.app_service
          (org_id, name, svc_type, hospital, vendor, username, password, env, sort, url, path, remark, enabled, created_by)
        OUTPUT INSERTED.*
        VALUES (@org, @name, @svc_type, @hospital, @vendor, @username, @password, @env, @sort, @url, @path, @remark, @enabled, @created_by)
      `);
      return map(res.recordset[0]);
    },

    // 局部更新：仅改传入字段；不存在返回 null。
    // 注意：UPDATE 的 OUTPUT 子句必须位于 SET 之后（UPDATE 前置 OUTPUT 会报语法错，见 mssqlFileStore 注释）。
    async update(id, orgId, patch = {}) {
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, num);
      req.input('org', sql.BigInt, orgId == null ? DEFAULT_ORG_ID : Number(orgId));
      const sets = [];
      for (const [k, t] of [
        ['name', sql.NVarChar(255)], ['hospital', sql.NVarChar(255)], ['vendor', sql.NVarChar(255)],
        ['username', sql.NVarChar(255)], ['password', sql.NVarChar(255)],
        ['url', sql.NVarChar(1000)], ['path', sql.NVarChar(1000)], ['remark', sql.NVarChar(500)],
      ]) {
        if (patch[k] != null) { req.input(k, t, String(patch[k])); sets.push(`${k} = @${k}`); }
      }
      if (patch.svc_type != null) { req.input('svc_type', sql.NVarChar(50), normalizeSvcType(patch.svc_type)); sets.push('svc_type = @svc_type'); }
      if (patch.env != null) { req.input('env', sql.NVarChar(32), normalizeSvcEnv(patch.env)); sets.push('env = @env'); }
      if (patch.sort != null) { req.input('sort', sql.Int, Number(patch.sort) || 0); sets.push('sort = @sort'); }
      if (patch.enabled != null) { req.input('enabled', sql.Bit, patch.enabled ? 1 : 0); sets.push('enabled = @enabled'); }
      if (!sets.length) return this.getById(num, orgId);
      sets.push('updated_at = GETDATE()');
      const res = await req.query(`UPDATE dbo.app_service SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE id = @id AND org_id = @org`);
      return res.recordset.length ? map(res.recordset[0]) : null;
    },

    // 物理删除：返回被删记录；不存在返回 null。
    async remove(id, orgId) {
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, num);
      req.input('org', sql.BigInt, orgId == null ? DEFAULT_ORG_ID : Number(orgId));
      const res = await req.query('DELETE FROM dbo.app_service OUTPUT DELETED.* WHERE id = @id AND org_id = @org');
      return res.recordset.length ? map(res.recordset[0]) : null;
    },

    // 机构级联清理（删除机构时用）：返回被删记录列表。
    async removeByOrg(orgId) {
      if (orgId == null) return [];
      const p = await getPool();
      const req = p.request();
      req.input('org', sql.BigInt, Number(orgId));
      const res = await req.query('DELETE FROM dbo.app_service OUTPUT DELETED.* WHERE org_id = @org');
      return res.recordset.map(map);
    },
  };
}
