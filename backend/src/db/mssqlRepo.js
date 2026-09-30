import sql from 'mssql';
import { normalizeSort } from './sort.js';
import { computeDashboard } from './aggregate.js';

// 排序字段白名单 → 实际 SQL 表达式（类型安全，杜绝拼接注入）。
// 严重程度与状态用 CASE 映射为业务语义序。
const SORT_SQL = {
  id: 'id',
  title: 'title',
  department: 'department',
  reporter: 'reporter',
  type: 'type',
  severity: "CASE severity WHEN N'低' THEN 1 WHEN N'中' THEN 2 WHEN N'高' THEN 3 WHEN N'紧急' THEN 4 ELSE 9 END",
  status: "CASE status WHEN N'待处理' THEN 1 WHEN N'处理中' THEN 2 WHEN N'已解决' THEN 3 WHEN N'已关闭' THEN 4 ELSE 9 END",
  created_at: 'created_at',
  updated_at: 'updated_at',
  resolved_at: 'resolved_at',
  audit_at: 'audit_at',
};

function orderByClause(sort, order) {
  const { by, dir } = normalizeSort(sort, order);
  const expr = SORT_SQL[by] || SORT_SQL.created_at;
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  // 同值时用 id 兜底（方向与主排序一致），保证分页稳定且"最新在前"不被同秒记录打乱
  return `ORDER BY ${expr} ${direction}, id ${direction}`;
}

function parseAttachments(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    org_id: row.org_id == null ? 1 : Number(row.org_id),
    title: row.title,
    department: row.department,
    reporter: row.reporter,
    contact: row.contact,
    type: row.type,
    severity: row.severity,
    status: row.status,
    description: row.description,
    handler: row.handler,
    registrar: row.registrar || '',
    softwareSystem: row.softwareSystem || '',
    resolution: row.resolution,
    attachments: parseAttachments(row.attachments),
    createdBy: row.createdBy || '',
    // 审核字段：旧库 NULL 兜底为「待审核」
    audit_status: row.audit_status || '待审核',
    audit_reason: row.audit_reason || '',
    audit_by: row.audit_by || '',
    audit_at: row.audit_at ? new Date(row.audit_at).toISOString() : null,
    satisfaction: row.satisfaction || '',
    feedback: row.feedback || '',
    rated_at: row.rated_at ? new Date(row.rated_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    // 回收站（v1.6 软删除）：null=正常，非空=已入回收站
    deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
  };
}

// 生产用：SQL Server 仓库（mssql / tedious，纯 JS 驱动）。
export function createMssqlRepo(cfg) {
  let pool;

  async function getPool() {
    if (!pool) {
      try {
        pool = await new sql.ConnectionPool(cfg).connect();
      } catch (e) {
        // 原始英文错误只进日志，对外统一中文提示
        console.error('[mssql] 连接失败：', e && e.message ? e.message : e);
        throw new Error('数据库连接失败，请检查数据库配置或联系管理员');
      }
      await initTable();
    }
    return pool;
  }

  async function initTable() {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'software_issue')
      BEGIN
        CREATE TABLE dbo.software_issue (
          id          BIGINT IDENTITY(1,1) PRIMARY KEY,
          title       NVARCHAR(255) NOT NULL,
          department  NVARCHAR(100) NOT NULL,
          reporter    NVARCHAR(100) NOT NULL,
          contact     NVARCHAR(100),
          type        NVARCHAR(20)  NOT NULL,
          severity    NVARCHAR(20)  NOT NULL,
          status      NVARCHAR(20)  NOT NULL DEFAULT N'待处理',
          description NVARCHAR(MAX) NOT NULL,
          handler     NVARCHAR(100),
          resolution  NVARCHAR(MAX),
          attachments NVARCHAR(MAX),
          created_at  DATETIME NOT NULL DEFAULT GETDATE(),
          updated_at  DATETIME NOT NULL DEFAULT GETDATE(),
          resolved_at DATETIME,
          deleted_at  DATETIME
        );
        CREATE INDEX ix_software_issue_status ON dbo.software_issue(status);
        CREATE INDEX ix_software_issue_type   ON dbo.software_issue(type);
        CREATE INDEX ix_software_issue_dept   ON dbo.software_issue(department);
      END
    `);
    // 增量列迁移：满意度回访 / 登记人（旧库平滑升级，不阻塞新库）
    const alters = [
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'satisfaction') ALTER TABLE dbo.software_issue ADD satisfaction NVARCHAR(20);`,
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'feedback') ALTER TABLE dbo.software_issue ADD feedback NVARCHAR(MAX);`,
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'rated_at') ALTER TABLE dbo.software_issue ADD rated_at DATETIME;`,
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'createdBy') ALTER TABLE dbo.software_issue ADD createdBy NVARCHAR(100);`,
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'registrar') ALTER TABLE dbo.software_issue ADD registrar NVARCHAR(100);`,
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'softwareSystem') ALTER TABLE dbo.software_issue ADD softwareSystem NVARCHAR(100);`,
      // 审核 4 列（v1.2 增量迁移）：旧数据自动落「待审核」
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'audit_status') ALTER TABLE dbo.software_issue ADD audit_status NVARCHAR(20) NOT NULL DEFAULT N'待审核' WITH VALUES;`,
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'audit_reason') ALTER TABLE dbo.software_issue ADD audit_reason NVARCHAR(MAX);`,
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'audit_by') ALTER TABLE dbo.software_issue ADD audit_by NVARCHAR(100);`,
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'audit_at') ALTER TABLE dbo.software_issue ADD audit_at DATETIME;`,
      // 回收站（v1.6 增量迁移）：软删除标记，NULL=正常，非空=已入回收站
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'deleted_at') ALTER TABLE dbo.software_issue ADD deleted_at DATETIME;`,
      // 多机构（v1.18 增量迁移）：数据归属机构。默认值 = 1（首次启动自动创建的默认机构），
      // 存量数据与未显式指定机构的新数据均自动归属默认机构；P3 起按机构过滤。
      `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'org_id') ALTER TABLE dbo.software_issue ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;`,
    ];
    for (const sqlText of alters) {
      try { await pool.request().query(sqlText); } catch { /* 容忍列已存在等情况 */ }
    }
  }

  // 筛选值归一化（v1.18.45 多选）：兼容数组（新）与单字符串（旧），统一为数组（上限 50 防超长）。
  const asMultiArr = (v) => (Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : [])).slice(0, 50);

  function buildWhere(req, f = {}) {
    const clauses = [];

    // 多值筛选生成 IN 子句：单值仍用「=」走原参数名（旧行为零变化）；
    // 多值用「@<name><下标>」动态占位（每个值独立注册参数，严禁复用同名参数重复输入）。
    function multiClause(col, name, values, type, size) {
      if (values.length === 1) {
        clauses.push(`${col} = @${name}`);
        req.input(name, size ? type(size) : type(), values[0]);
        return;
      }
      const ph = values.map((_, i) => `@${name}${i}`).join(',');
      clauses.push(`${col} IN (${ph})`);
      values.forEach((v, i) => req.input(`${name}${i}`, size ? type(size) : type(), v));
    }
    // 多机构（v1.18）行级隔离：只在显式传入 orgId 时施加，缺省保持旧行为
    if (f.orgId != null) { clauses.push('org_id = @org'); req.input('org', sql.BigInt, f.orgId); }
    // 回收站口径（v1.6）：默认仅未删除记录；f.deleted === true 时仅回收站记录
    if (f.deleted === true) clauses.push('deleted_at IS NOT NULL');
    else clauses.push('deleted_at IS NULL');
    const statusArr = asMultiArr(f.status);
    if (statusArr.length) multiClause('status', 'status', statusArr, sql.NVarChar, 20);
    if (f.auditStatus) { clauses.push('audit_status = @audit_status'); req.input('audit_status', sql.NVarChar(20), f.auditStatus); }
    const typeArr = asMultiArr(f.type);
    if (typeArr.length) multiClause('type', 'type', typeArr, sql.NVarChar, 20);
    const deptArr = asMultiArr(f.department);
    if (deptArr.length) multiClause('department', 'department', deptArr, sql.NVarChar, 100);
    if (f.keyword) {
      clauses.push('(title LIKE @kw OR department LIKE @kw OR reporter LIKE @kw OR description LIKE @kw OR handler LIKE @kw OR registrar LIKE @kw OR softwareSystem LIKE @kw)');
      req.input('kw', sql.NVarChar(255), `%${f.keyword}%`);
    }
    return clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  }

  return {
    async init() { await getPool(); },

    // 运维知识库（v1.18.27）：派生视图 —— 所有写了处理说明的问题自动收录。
    // 独立构建 WHERE（不复用 buildWhere，避免影响存量 list 语义）；
    // 参数注册点唯一：每个 @ 参数只在对应请求上 input 一次。
    async listKb({ keyword, type, page = 1, pageSize = 20, sort, order, orgId } = {}) {
      const p = await getPool();

      // 形参名刻意避开 buildWhere 的 req：mssql-params 静态检查按「接收者变量名」
      // 分组判定同实例重复注册，不同函数的同名形参会被误判（函数参数无法被静态追踪重置）。
      function kbWhere(rq) {
        const clauses = [];
        if (orgId != null) { clauses.push('org_id = @org'); rq.input('org', sql.BigInt, orgId); }
        clauses.push('deleted_at IS NULL');
        clauses.push("resolution IS NOT NULL AND LTRIM(RTRIM(resolution)) <> N''");
        if (type) { clauses.push('type = @type'); rq.input('type', sql.NVarChar(20), type); }
        if (keyword) {
          clauses.push('(title LIKE @kw OR description LIKE @kw OR resolution LIKE @kw OR softwareSystem LIKE @kw OR department LIKE @kw OR handler LIKE @kw)');
          rq.input('kw', sql.NVarChar(255), `%${keyword}%`);
        }
        return clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
      }

      const totalReq = p.request();
      const where = kbWhere(totalReq);
      const totalRes = await totalReq.query(`SELECT COUNT(*) AS c FROM dbo.software_issue ${where}`);
      const total = totalRes.recordset[0].c;

      const req = p.request();
      kbWhere(req);
      req.input('offset', sql.Int, (Number(page) - 1) * Number(pageSize));
      req.input('limit', sql.Int, Number(pageSize));
      const res = await req.query(
        `SELECT * FROM dbo.software_issue ${where} ${orderByClause(sort, order)} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
      );
      return { rows: res.recordset.map(mapRow), total, page: Number(page), pageSize: Number(pageSize) };
    },

    async list({ status, type, department, keyword, auditStatus, deleted, page = 1, pageSize = 20, sort, order, orgId } = {}) {
      const p = await getPool();
      const where = buildWhere(p.request(), { status, type, department, keyword, auditStatus, deleted, orgId });
      const totalReq = p.request();
      buildWhere(totalReq, { status, type, department, keyword, auditStatus, deleted, orgId });
      const totalRes = await totalReq.query(`SELECT COUNT(*) AS c FROM dbo.software_issue ${where}`);
      const total = totalRes.recordset[0].c;

      const req = p.request();
      buildWhere(req, { status, type, department, keyword, auditStatus, orgId });
      req.input('offset', sql.Int, (Number(page) - 1) * Number(pageSize));
      req.input('limit', sql.Int, Number(pageSize));
      const res = await req.query(
        `SELECT * FROM dbo.software_issue ${where} ${orderByClause(sort, order)} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
      );
      return { rows: res.recordset.map(mapRow), total };
    },

    // 详情：默认不含已删除记录（已删记录对外视为不存在）
    async get(id, orgId) {
      const p = await getPool();
      const req = p.request().input('id', sql.BigInt, id);
      let where = 'id = @id AND deleted_at IS NULL';
      if (orgId != null) { where += ' AND org_id = @org'; req.input('org', sql.BigInt, orgId); }
      const res = await req.query(`SELECT * FROM dbo.software_issue WHERE ${where}`);
      return mapRow(res.recordset[0]);
    },

    // 详情（含已删除）：回收站「查看 / 恢复 / 彻底删除」前取记录用
    async getByIdIncludeDeleted(id, orgId) {
      const p = await getPool();
      const req = p.request().input('id', sql.BigInt, id);
      let where = 'id = @id';
      if (orgId != null) { where += ' AND org_id = @org'; req.input('org', sql.BigInt, orgId); }
      const res = await req.query(`SELECT * FROM dbo.software_issue WHERE ${where}`);
      return mapRow(res.recordset[0]);
    },

    async create(data) {
      const p = await getPool();
      const req = p.request();
      // 机构归属（v1.18）：由路由层注入当前机构；缺省落默认机构（id=1）
      req.input('org', sql.BigInt, data.org_id == null ? 1 : Number(data.org_id));
      req.input('title', sql.NVarChar(255), data.title);
      req.input('department', sql.NVarChar(100), data.department);
      req.input('reporter', sql.NVarChar(100), data.reporter);
      req.input('contact', sql.NVarChar(100), data.contact || null);
      req.input('type', sql.NVarChar(20), data.type);
      req.input('severity', sql.NVarChar(20), data.severity);
      req.input('status', sql.NVarChar(20), data.status || '待处理');
      req.input('description', sql.NVarChar(sql.MAX), data.description);
      req.input('handler', sql.NVarChar(100), data.handler || null);
      req.input('registrar', sql.NVarChar(100), data.registrar || null);
      req.input('softwareSystem', sql.NVarChar(100), data.softwareSystem || null);
      req.input('resolution', sql.NVarChar(sql.MAX), data.resolution || null);
      req.input('attachments', sql.NVarChar(sql.MAX), JSON.stringify(Array.isArray(data.attachments) ? data.attachments : []));
      req.input('createdBy', sql.NVarChar(100), data.createdBy || null);
      req.input('satisfaction', sql.NVarChar(20), data.satisfaction || null);
      req.input('feedback', sql.NVarChar(sql.MAX), data.feedback || null);
      req.input('rated_at', sql.DateTime, data.satisfaction ? new Date() : null);
      req.input('resolved_at', sql.DateTime, (data.status === '已解决' || data.status === '已关闭') ? new Date() : null);
      const res = await req.query(`
        INSERT INTO dbo.software_issue
          (org_id, title, department, reporter, contact, type, severity, status, description, handler, registrar, softwareSystem, resolution, attachments, createdBy, satisfaction, feedback, rated_at, resolved_at, updated_at)
        OUTPUT INSERTED.*
        VALUES (@org, @title, @department, @reporter, @contact, @type, @severity, @status, @description, @handler, @registrar, @softwareSystem, @resolution, @attachments, @createdBy, @satisfaction, @feedback, @rated_at, @resolved_at, GETDATE())
      `);
      return mapRow(res.recordset[0]);
    },

    async update(id, data, orgId) {
      const p = await getPool();
      const cur = await this.get(id, orgId);
      if (!cur) return null;
      // 审核字段只允许走审核接口维护，编辑接口一律忽略
      const safe = { ...data };
      delete safe.audit_status; delete safe.audit_reason; delete safe.audit_by; delete safe.audit_at;
      const merged = { ...cur, ...safe };
      const req = p.request();
      req.input('id', sql.BigInt, id);
      if (orgId != null) req.input('org', sql.BigInt, orgId);
      req.input('title', sql.NVarChar(255), merged.title);
      req.input('department', sql.NVarChar(100), merged.department);
      req.input('reporter', sql.NVarChar(100), merged.reporter);
      req.input('contact', sql.NVarChar(100), merged.contact || null);
      req.input('type', sql.NVarChar(20), merged.type);
      req.input('severity', sql.NVarChar(20), merged.severity);
      req.input('status', sql.NVarChar(20), merged.status);
      req.input('description', sql.NVarChar(sql.MAX), merged.description);
      req.input('handler', sql.NVarChar(100), merged.handler || null);
      req.input('registrar', sql.NVarChar(100), merged.registrar || null);
      req.input('softwareSystem', sql.NVarChar(100), merged.softwareSystem || null);
      req.input('resolution', sql.NVarChar(sql.MAX), merged.resolution || null);
      req.input('attachments', sql.NVarChar(sql.MAX), JSON.stringify(Array.isArray(merged.attachments) ? merged.attachments : []));
      req.input('satisfaction', sql.NVarChar(20), merged.satisfaction || null);
      req.input('feedback', sql.NVarChar(sql.MAX), merged.feedback || null);
      req.input('rated_at', sql.DateTime,
        ('satisfaction' in data)
          ? (data.satisfaction ? new Date() : null)
          : (cur.rated_at ? new Date(cur.rated_at) : null));
      req.input('resolved_at', sql.DateTime,
        (merged.status === '已解决' || merged.status === '已关闭')
          ? (cur.resolved_at ? new Date(cur.resolved_at) : new Date())
          : null);
      const res = await req.query(`
        UPDATE dbo.software_issue SET
          title=@title, department=@department, reporter=@reporter, contact=@contact,
          type=@type, severity=@severity, status=@status, description=@description,
          handler=@handler, registrar=@registrar, softwareSystem=@softwareSystem, resolution=@resolution, attachments=@attachments,
          satisfaction=@satisfaction, feedback=@feedback, rated_at=@rated_at, resolved_at=@resolved_at, updated_at=GETDATE()
        OUTPUT INSERTED.*
        WHERE id=@id${orgId != null ? ' AND org_id=@org' : ''}
      `);
      return mapRow(res.recordset[0]);
    },

    // 审核：仅覆写 4 个审核字段（允许重复审核覆盖），其余字段不动
    async audit(id, patch = {}, orgId) {
      const p = await getPool();
      const cur = await this.get(id, orgId);
      if (!cur) return null;
      const req = p.request();
      req.input('id', sql.BigInt, id);
      if (orgId != null) req.input('org', sql.BigInt, orgId);
      req.input('audit_status', sql.NVarChar(20), patch.audit_status);
      req.input('audit_reason', sql.NVarChar(sql.MAX), patch.audit_reason || null);
      req.input('audit_by', sql.NVarChar(100), patch.audit_by || null);
      req.input('audit_at', sql.DateTime, patch.audit_at ? new Date(patch.audit_at) : new Date());
      const res = await req.query(`
        UPDATE dbo.software_issue SET
          audit_status=@audit_status, audit_reason=@audit_reason, audit_by=@audit_by, audit_at=@audit_at, updated_at=GETDATE()
        OUTPUT INSERTED.*
        WHERE id=@id${orgId != null ? ' AND org_id=@org' : ''}
      `);
      return mapRow(res.recordset[0]);
    },

    // 软删除（v1.6 回收站）：置 deleted_at，不真删；返回受影响行数
    async softRemove(id, orgId) {
      const p = await getPool();
      const req = p.request().input('id', sql.BigInt, id);
      let where = 'id = @id AND deleted_at IS NULL';
      if (orgId != null) { where += ' AND org_id = @org'; req.input('org', sql.BigInt, orgId); }
      const res = await req.query(`UPDATE dbo.software_issue SET deleted_at = GETDATE(), updated_at = GETDATE() WHERE ${where}`);
      return res.rowsAffected[0] || 0;
    },

    // 从回收站恢复：清空 deleted_at；返回受影响行数
    async restore(id, orgId) {
      const p = await getPool();
      const req = p.request().input('id', sql.BigInt, id);
      let where = 'id = @id AND deleted_at IS NOT NULL';
      if (orgId != null) { where += ' AND org_id = @org'; req.input('org', sql.BigInt, orgId); }
      const res = await req.query(`UPDATE dbo.software_issue SET deleted_at = NULL, updated_at = GETDATE() WHERE ${where}`);
      return res.rowsAffected[0] || 0;
    },

    // 彻底删除（真删）：OUTPUT DELETED 拿附件元数据，调用方据此清理磁盘文件
    async hardRemove(id, orgId) {
      const p = await getPool();
      const req = p.request().input('id', sql.BigInt, id);
      let where = 'id = @id';
      if (orgId != null) { where += ' AND org_id = @org'; req.input('org', sql.BigInt, orgId); }
      const res = await req.query(`DELETE FROM dbo.software_issue OUTPUT DELETED.id, DELETED.attachments WHERE ${where}`);
      if (!res.recordset.length) return null;
      return { id: res.recordset[0].id, attachments: parseAttachments(res.recordset[0].attachments) };
    },

    // 批量改状态：单条 UPDATE ... WHERE id IN (...) ，输出受影响行数
    async bulkUpdateStatus(ids = [], status, orgId) {
      const p = await getPool();
      const req = p.request();
      const names = ids.map((id, i) => { req.input(`id${i}`, sql.BigInt, id); return `@id${i}`; });
      req.input('status', sql.NVarChar(20), status);
      if (orgId != null) req.input('org', sql.BigInt, orgId);
      const resolvedExpr = (status === '已解决' || status === '已关闭')
        ? 'ISNULL(resolved_at, GETDATE())'
        : 'NULL';
      const res = await req.query(`
        UPDATE dbo.software_issue
        SET status = @status, resolved_at = ${resolvedExpr}, updated_at = GETDATE()
        OUTPUT INSERTED.id
        WHERE id IN (${names.join(',')})${orgId != null ? ' AND org_id = @org' : ''}
      `);
      return res.recordset.length;
    },

    // 批量软删除（v1.6 回收站）：仅对未删除记录置 deleted_at；
    // 返回被软删的记录（含附件元数据），不清理磁盘文件（恢复后附件仍可用）。
    async bulkRemove(ids = [], orgId) {
      const p = await getPool();
      const req = p.request();
      const names = ids.map((id, i) => { req.input(`id${i}`, sql.BigInt, id); return `@id${i}`; });
      if (orgId != null) req.input('org', sql.BigInt, orgId);
      const res = await req.query(`
        UPDATE dbo.software_issue
        SET deleted_at = GETDATE(), updated_at = GETDATE()
        OUTPUT INSERTED.id, INSERTED.attachments
        WHERE id IN (${names.join(',')}) AND deleted_at IS NULL${orgId != null ? ' AND org_id = @org' : ''}
      `);
      return res.recordset.map((r) => ({ id: r.id, attachments: parseAttachments(r.attachments) }));
    },

    async stats(orgId) {
      const p = await getPool();
      const orgCond = orgId != null ? ' AND org_id = @org' : '';
      // 仅在需要时注册 @org 参数，避免出现未被语句引用的参数
      const req = () => {
        const r = p.request();
        if (orgId != null) r.input('org', sql.BigInt, orgId);
        return r;
      };
      // 统计口径：不含回收站记录
      const [s, t, d, sat, tot] = await Promise.all([
        req().query(`SELECT status AS k, COUNT(*) AS c FROM dbo.software_issue WHERE deleted_at IS NULL${orgCond} GROUP BY status`),
        req().query(`SELECT type AS k, COUNT(*) AS c FROM dbo.software_issue WHERE deleted_at IS NULL${orgCond} GROUP BY type`),
        req().query(`SELECT department AS k, COUNT(*) AS c FROM dbo.software_issue WHERE deleted_at IS NULL${orgCond} GROUP BY department`),
        req().query(`SELECT ISNULL(satisfaction, N'') AS k, COUNT(*) AS c FROM dbo.software_issue WHERE deleted_at IS NULL${orgCond} GROUP BY satisfaction`),
        req().query(`SELECT COUNT(*) AS c FROM dbo.software_issue WHERE deleted_at IS NULL${orgCond}`),
      ]);
      const toMap = (r) => { const m = {}; for (const x of r.recordset) m[x.k || '未知'] = x.c; return m; };
      return { total: tot.recordset[0].c, byStatus: toMap(s), byType: toMap(t), byDepartment: toMap(d), bySatisfaction: toMap(sat) };
    },

    async exportRows({ status, type, department, keyword, auditStatus, deleted, sort, order, orgId } = {}) {
      const p = await getPool();
      const req = p.request();
      // 导出：默认仅未删除记录（回收站数据不进报表）
      const where = buildWhere(req, { status, type, department, keyword, auditStatus, deleted, orgId });
      const res = await req.query(`SELECT * FROM dbo.software_issue ${where} ${orderByClause(sort, order)}`);
      return res.recordset.map(mapRow);
    },

    async trend(orgId) {
      const p = await getPool();
      const orgCond = orgId != null ? ' AND org_id = @org' : '';
      const req = () => {
        const r = p.request();
        if (orgId != null) r.input('org', sql.BigInt, orgId);
        return r;
      };
      // 趋势口径：不含回收站记录
      const [d, m] = await Promise.all([
        req().query(`SELECT department AS k, COUNT(*) AS c FROM dbo.software_issue WHERE deleted_at IS NULL${orgCond} GROUP BY department`),
        req().query(`SELECT FORMAT(created_at, 'yyyy-MM') AS k, COUNT(*) AS c FROM dbo.software_issue WHERE deleted_at IS NULL${orgCond} GROUP BY FORMAT(created_at, 'yyyy-MM') ORDER BY k`),
      ]);
      const byDepartment = d.recordset.map((x) => ({ department: x.k || '未知', count: x.c })).sort((a, b) => b.count - a.count);
      const byMonth = m.recordset.map((x) => ({ month: x.k, count: x.c }));
      return { byDepartment, byMonth };
    },

    // 数据驾驶舱：拉取聚合所需字段后，交给与 dev 侧共用的 computeDashboard 计算，
    // 保证两驱动数字口径一致（补零/排序/环比等逻辑仅此一处）。
    async dashboard(orgId) {
      const p = await getPool();
      const orgCond = orgId != null ? ' AND org_id = @org' : '';
      const req = p.request();
      if (orgId != null) req.input('org', sql.BigInt, orgId);
      // 驾驶舱口径：不含回收站记录
      const res = await req.query(`
        SELECT status, type, severity, department, handler, softwareSystem, createdBy,
               created_at, resolved_at, satisfaction
        FROM dbo.software_issue
        WHERE deleted_at IS NULL${orgCond}
      `);
      const rows = res.recordset.map((r) => ({
        status: r.status,
        type: r.type,
        severity: r.severity,
        department: r.department,
        handler: r.handler,
        softwareSystem: r.softwareSystem,
        createdBy: r.createdBy,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
        resolved_at: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
        satisfaction: r.satisfaction || '',
      }));
      return computeDashboard(rows, new Date());
    },
  };
}
