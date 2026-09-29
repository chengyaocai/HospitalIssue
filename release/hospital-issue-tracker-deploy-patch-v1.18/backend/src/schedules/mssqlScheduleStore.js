import sql from 'mssql';
import { addDays, diffDays } from './dateUtil.js';

// 生产用：SQL Server 值班表（dbo.duty_schedule）。
export function createMssqlScheduleStore(cfg) {
  let pool;
  async function getPool() {
    if (!pool) {
      pool = await new sql.ConnectionPool(cfg).connect();
      await initTable();
    }
    return pool;
  }
  // 启动时自动建表（若不存在）：与 schema.sql 第 6 节保持一致，正常升级无需手工执行 SQL。
  async function initTable() {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'duty_schedule')
      BEGIN
        CREATE TABLE dbo.duty_schedule (
          id               BIGINT IDENTITY(1,1) PRIMARY KEY,
          duty_date        DATE NOT NULL,
          handler_username NVARCHAR(50),
          handler_name     NVARCHAR(100) NOT NULL,
          note             NVARCHAR(200),
          created_by       NVARCHAR(50),
          created_at       DATETIME NOT NULL DEFAULT GETDATE(),
          synced           INT NOT NULL DEFAULT 0
        );
        CREATE INDEX ix_duty_schedule_date ON dbo.duty_schedule(duty_date);
      END
    `);
    // 多机构（v1.18 增量迁移）：排班归属机构，默认 1（默认机构）。
    try {
      await pool.request().query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.duty_schedule') AND name = N'org_id') ALTER TABLE dbo.duty_schedule ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;`);
    } catch { /* 容忍列已存在等情况 */ }
    // 同步来源标记（v1.18.18 增量迁移）：0=手工/复制周（永不被镜像同步删除），1=上次跨机构同步产生。
    // 平滑加列 WITH VALUES 0：存量条目（含 v1.18.13 时代同步产生的）全部自动视为手工、不受影响。
    try {
      await pool.request().query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.duty_schedule') AND name = N'synced') ALTER TABLE dbo.duty_schedule ADD synced INT NOT NULL DEFAULT 0 WITH VALUES;`);
    } catch { /* 容忍列已存在等情况 */ }
  }

  // DATE 列取回为「本地时区零点」的 JS Date，用本地年月日拼回 YYYY-MM-DD，避免 toISOString 的时区偏移。
  const fmtDate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // 数据库列名 -> 统一字段名（与 devScheduleStore 完全一致）。
  const map = (r) => ({
    id: r.id,
    org_id: r.org_id == null ? 1 : Number(r.org_id),
    date: r.duty_date ? fmtDate(new Date(r.duty_date)) : '',
    handlerUsername: r.handler_username || '',
    handlerName: r.handler_name || '',
    note: r.note || '',
    createdBy: r.created_by || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    synced: r.synced ? 1 : 0,
  });

  function bind(req, entry) {
    req.input('date', sql.VarChar(10), entry.date || '');
    req.input('username', sql.NVarChar(50), entry.handlerUsername || null);
    req.input('name', sql.NVarChar(100), entry.handlerName || '');
    req.input('note', sql.NVarChar(200), entry.note || null);
    req.input('createdBy', sql.NVarChar(50), entry.createdBy || null);
    // 同步来源标记（v1.18.18）：复制周 / 手工新增不打标（缺省 0），sync 侧显式传 synced:1。
    req.input('synced', sql.Bit, entry.synced ? 1 : 0);
  }

  // 机构参数（v1.18）：仅在语句真正引用 @org 时注册，避免出现未被引用的参数。
  function bindOrg(req, orgId) {
    req.input('org', sql.BigInt, orgId == null ? 1 : Number(orgId));
  }

  const INSERT = 'INSERT INTO dbo.duty_schedule (org_id,duty_date,handler_username,handler_name,note,created_by,synced) OUTPUT INSERTED.* VALUES (@org,@date,@username,@name,@note,@createdBy,@synced)';

  // 范围查询（含端点）；日期统一转 VARCHAR(10) 后字符串比较，规避 DATE 参数绑定的时区歧义。
  // orgId 提供时追加机构过滤。
  async function queryRange(from, to, orgId) {
    const p = await getPool();
    const req = p.request();
    let where = '1=1';
    if (from) { req.input('from', sql.VarChar(10), from); where += ' AND CONVERT(VARCHAR(10), duty_date, 23) >= @from'; }
    if (to) { req.input('to', sql.VarChar(10), to); where += ' AND CONVERT(VARCHAR(10), duty_date, 23) <= @to'; }
    if (orgId != null) { bindOrg(req, orgId); where += ' AND org_id = @org'; }
    const res = await req.query(`SELECT * FROM dbo.duty_schedule WHERE ${where} ORDER BY duty_date ASC, id ASC`);
    return res.recordset.map(map);
  }

  // 「同日同一人」判重键：有账号用账号，否则用姓名。
  const personKey = (rec) => `${String(rec.date)}|${rec.handlerUsername || rec.handlerName}`;

  return {
    async listRange(from, to, orgId) {
      return queryRange(from, to, orgId);
    },
    async findById(id, orgId) {
      const numId = Number(id);
      if (!Number.isFinite(numId)) return null;
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, numId);
      let where = 'id=@id';
      if (orgId != null) { bindOrg(req, orgId); where += ' AND org_id=@org'; }
      const res = await req.query(`SELECT * FROM dbo.duty_schedule WHERE ${where}`);
      return res.recordset.length ? map(res.recordset[0]) : null;
    },
    async create(entry) {
      const p = await getPool();
      const req = p.request();
      bind(req, entry);
      bindOrg(req, entry.org_id);
      const res = await req.query(INSERT);
      return map(res.recordset[0]);
    },
    async update(id, patch, orgId) {
      const numId = Number(id);
      if (!Number.isFinite(numId)) return null;
      const p = await getPool();
      const req = p.request();
      // 动态 SET：仅更新 patch 里出现的字段（v1.18.18 的镜像同步只传 note / synced 等局部字段；
      // 手工编辑（PUT /:id）的 patch 不含 synced，因此不会意外重置同步来源标记）。
      const sets = [];
      if ('date' in patch) { req.input('date', sql.VarChar(10), patch.date || ''); sets.push('duty_date=@date'); }
      if ('handlerUsername' in patch) { req.input('username', sql.NVarChar(50), patch.handlerUsername || null); sets.push('handler_username=@username'); }
      if ('handlerName' in patch) { req.input('name', sql.NVarChar(100), patch.handlerName || ''); sets.push('handler_name=@name'); }
      if ('note' in patch) { req.input('note', sql.NVarChar(200), patch.note || null); sets.push('note=@note'); }
      if ('createdBy' in patch) { req.input('createdBy', sql.NVarChar(50), patch.createdBy || null); sets.push('created_by=@createdBy'); }
      if ('synced' in patch) { req.input('synced', sql.Bit, patch.synced ? 1 : 0); sets.push('synced=@synced'); }
      if (!sets.length) return null;
      req.input('id', sql.BigInt, numId);
      let where = 'id=@id';
      if (orgId != null) { bindOrg(req, orgId); where += ' AND org_id=@org'; }
      const res = await req.query(`UPDATE dbo.duty_schedule SET ${sets.join(',')} OUTPUT INSERTED.* WHERE ${where}`);
      return res.recordset.length ? map(res.recordset[0]) : null;
    },
    async remove(id, orgId) {
      const numId = Number(id);
      if (!Number.isFinite(numId)) return false;
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, numId);
      let where = 'id=@id';
      if (orgId != null) { bindOrg(req, orgId); where += ' AND org_id=@org'; }
      const res = await req.query(`DELETE FROM dbo.duty_schedule WHERE ${where}`);
      return (res.rowsAffected[0] || 0) > 0;
    },
    // 复制周排班：sourceFrom 起 7 天 -> targetFrom 起 7 天，跳过「目标日 + 同一人」已存在的。
    // 仅在同一机构内复制（源与目标都限定为 orgId）。
    async copyWeek(sourceFrom, targetFrom, orgId) {
      const p = await getPool();
      const source = await queryRange(sourceFrom, addDays(sourceFrom, 6), orgId);
      if (!source.length) return { copied: 0 };
      const existing = await queryRange(targetFrom, addDays(targetFrom, 6), orgId);
      const keys = new Set(existing.map(personKey));
      const toInsert = [];
      for (const rec of source) {
        const next = {
          org_id: rec.org_id,
          date: addDays(String(rec.date), diffDays(sourceFrom, targetFrom)),
          handlerUsername: rec.handlerUsername || '',
          handlerName: rec.handlerName || '',
          note: rec.note || '',
          createdBy: rec.createdBy || '',
        };
        const key = personKey(next);
        if (keys.has(key)) continue;
        keys.add(key);
        toInsert.push(next);
      }
      if (!toInsert.length) return { copied: 0 };
      let copied = 0;
      const tx = new sql.Transaction(p);
      await tx.begin();
      try {
        for (const entry of toInsert) {
          const req = new sql.Request(tx);
          bind(req, entry);
          bindOrg(req, entry.org_id == null ? orgId : entry.org_id);
          await req.query(INSERT);
          copied++;
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      return { copied };
    },
  };
}
