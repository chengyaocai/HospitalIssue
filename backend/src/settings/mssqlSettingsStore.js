import sql from 'mssql';

// 生产用：SQL Server 系统设置。
// - 全局（遗留 / 单机构）设置：dbo.app_setting（键值平铺）
// - 机构级设置（v1.18）：dbo.app_org_setting（org_id + 键值）
// 调用方不传 orgId 时走全局表，保持升级前行为不变。
export function createMssqlSettingsStore(cfg) {
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
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_setting')
      BEGIN
        CREATE TABLE dbo.app_setting (
          [key]   NVARCHAR(50) NOT NULL PRIMARY KEY,
          [value] NVARCHAR(MAX)
        );
      END
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_org_setting')
      BEGIN
        CREATE TABLE dbo.app_org_setting (
          org_id  BIGINT NOT NULL,
          [key]   NVARCHAR(50) NOT NULL,
          [value] NVARCHAR(MAX),
          CONSTRAINT pk_app_org_setting PRIMARY KEY (org_id, [key])
        );
      END
    `);
  }

  async function readGlobal() {
    const p = await getPool();
    const res = await p.request().query('SELECT [key], [value] FROM dbo.app_setting');
    const o = {};
    for (const r of res.recordset) o[r.key] = r.value;
    return o;
  }

  async function readOrg(orgId) {
    const p = await getPool();
    const res = await p.request().input('org', sql.BigInt, orgId)
      .query('SELECT [key], [value] FROM dbo.app_org_setting WHERE org_id=@org');
    const o = {};
    for (const r of res.recordset) o[r.key] = r.value;
    return o;
  }

  async function writeGlobal(patch) {
    const p = await getPool();
    for (const [k, v] of Object.entries(patch)) {
      await p.request()
        .input('k', sql.NVarChar(50), k)
        // 用 NVARCHAR(MAX) 承载 roles / permissions 等较长的 JSON 字符串，避免截断。
        .input('v', sql.NVarChar(sql.MAX), String(v))
        .query(`
          MERGE dbo.app_setting AS t
          USING (SELECT @k AS [key]) AS s ON t.[key] = s.[key]
          WHEN MATCHED THEN UPDATE SET [value] = @v
          WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (@k, @v);
        `);
    }
    return readGlobal();
  }

  async function writeOrg(patch, orgId) {
    const p = await getPool();
    for (const [k, v] of Object.entries(patch)) {
      await p.request()
        .input('org', sql.BigInt, orgId)
        .input('k', sql.NVarChar(50), k)
        .input('v', sql.NVarChar(sql.MAX), String(v))
        .query(`
          MERGE dbo.app_org_setting AS t
          USING (SELECT @org AS org_id, @k AS [key]) AS s
            ON t.org_id = s.org_id AND t.[key] = s.[key]
          WHEN MATCHED THEN UPDATE SET [value] = @v
          WHEN NOT MATCHED THEN INSERT (org_id, [key], [value]) VALUES (@org, @k, @v);
        `);
    }
    return readOrg(orgId);
  }

  return {
    async get(orgId) {
      return orgId == null ? readGlobal() : readOrg(orgId);
    },
    async update(patch, orgId) {
      return orgId == null ? writeGlobal(patch) : writeOrg(patch, orgId);
    },
  };
}
