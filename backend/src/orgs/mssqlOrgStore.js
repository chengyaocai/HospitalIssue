import sql from 'mssql';

// 生产用：SQL Server 机构表（dbo.app_org）与用户-机构成员关系表（dbo.app_user_org）。
// 表结构由本模块启动时按需自动创建（IF NOT EXISTS），无需手工执行 SQL。
export function createMssqlOrgStore(cfg) {
  let pool;

  async function getPool() {
    if (!pool) {
      try {
        pool = await new sql.ConnectionPool(cfg).connect();
      } catch (e) {
        console.error('[mssql] 连接失败：', e && e.message ? e.message : e);
        throw new Error('数据库连接失败，请检查数据库配置或联系管理员');
      }
      await initTables();
    }
    return pool;
  }

  async function initTables() {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_org')
      BEGIN
        CREATE TABLE dbo.app_org (
          id          BIGINT IDENTITY(1,1) PRIMARY KEY,
          code        NVARCHAR(50)  NOT NULL UNIQUE,
          name        NVARCHAR(100) NOT NULL,
          active      BIT NOT NULL DEFAULT 1,
          created_at  DATETIME NOT NULL DEFAULT GETDATE()
        );
      END
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_user_org')
      BEGIN
        CREATE TABLE dbo.app_user_org (
          id          BIGINT IDENTITY(1,1) PRIMARY KEY,
          user_id     BIGINT NOT NULL,
          org_id      BIGINT NOT NULL,
          role        NVARCHAR(30) NOT NULL DEFAULT N'reporter',
          created_at  DATETIME NOT NULL DEFAULT GETDATE()
        );
        CREATE UNIQUE INDEX ux_app_user_org ON dbo.app_user_org(user_id, org_id);
      END
    `);
  }

  const mapOrg = (r) => (r ? {
    id: r.id,
    code: r.code,
    name: r.name,
    active: r.active !== false && r.active !== 0,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  } : null);

  const mapMember = (r) => ({ user_id: r.user_id, org_id: r.org_id, role: r.role || 'reporter' });

  async function getById(id) {
    const p = await getPool();
    const res = await p.request().input('id', sql.BigInt, id)
      .query('SELECT * FROM dbo.app_org WHERE id=@id');
    return mapOrg(res.recordset[0]);
  }

  return {
    async list() {
      const p = await getPool();
      const res = await p.request().query('SELECT * FROM dbo.app_org ORDER BY id ASC');
      return res.recordset.map(mapOrg);
    },
    async get(id) { return getById(id); },
    async findByCode(code) {
      const p = await getPool();
      const res = await p.request().input('code', sql.NVarChar(50), code)
        .query('SELECT * FROM dbo.app_org WHERE code=@code');
      return mapOrg(res.recordset[0]);
    },
    async create({ code, name }) {
      const p = await getPool();
      if (code) {
        const ex = await p.request().input('code', sql.NVarChar(50), code)
          .query('SELECT id FROM dbo.app_org WHERE code=@code');
        if (ex.recordset.length) return null;
      }
      // 未指定 code 时先用随机占位值插入（保证 UNIQUE 不冲突），拿到自增 id 后再回填 org{id}。
      const tmpCode = code || `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const req = p.request();
      req.input('code', sql.NVarChar(50), tmpCode);
      req.input('name', sql.NVarChar(100), String(name || '').trim() || '机构');
      const res = await req.query('INSERT INTO dbo.app_org (code,name,active) OUTPUT INSERTED.* VALUES (@code,@name,1)');
      const inserted = res.recordset[0];
      if (code) return mapOrg(inserted);
      const upd = await p.request().input('id', sql.BigInt, inserted.id)
        .query("UPDATE dbo.app_org SET code=CONCAT(N'org', CONVERT(NVARCHAR(20), id)) OUTPUT INSERTED.* WHERE id=@id");
      return mapOrg(upd.recordset[0]);
    },
    async update(id, patch = {}) {
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, id);
      const sets = [];
      if (typeof patch.name === 'string' && patch.name.trim()) {
        sets.push('name=@name');
        req.input('name', sql.NVarChar(100), patch.name.trim().slice(0, 60));
      }
      if (typeof patch.active === 'boolean') {
        sets.push('active=@active');
        req.input('active', sql.Bit, patch.active ? 1 : 0);
      }
      if (!sets.length) return getById(id);
      const res = await req.query(`UPDATE dbo.app_org SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE id=@id`);
      return mapOrg(res.recordset[0]);
    },
    // 删除机构会连带清理其成员关系（守卫「至少保留一个机构」由上层负责）。
    async remove(id) {
      const p = await getPool();
      const tx = new sql.Transaction(p);
      await tx.begin();
      try {
        const delMembers = new sql.Request(tx);
        delMembers.input('id', sql.BigInt, id);
        await delMembers.query('DELETE FROM dbo.app_user_org WHERE org_id=@id');
        const delOrg = new sql.Request(tx);
        delOrg.input('id', sql.BigInt, id);
        const res = await delOrg.query('DELETE FROM dbo.app_org WHERE id=@id');
        await tx.commit();
        return (res.rowsAffected[0] || 0) > 0;
      } catch (e) {
        await tx.rollback();
        throw e;
      }
    },
    async count() {
      const p = await getPool();
      const res = await p.request().query('SELECT COUNT(*) AS c FROM dbo.app_org');
      return res.recordset[0].c;
    },
    async memberCount(orgId) {
      const p = await getPool();
      const res = await p.request().input('id', sql.BigInt, orgId)
        .query('SELECT COUNT(*) AS c FROM dbo.app_user_org WHERE org_id=@id');
      return res.recordset[0].c;
    },
    async membersOf(orgId) {
      const p = await getPool();
      const res = await p.request().input('id', sql.BigInt, orgId)
        .query('SELECT user_id, org_id, role FROM dbo.app_user_org WHERE org_id=@id ORDER BY user_id');
      return res.recordset.map(mapMember);
    },
    async orgsOf(userId) {
      const p = await getPool();
      const res = await p.request().input('uid', sql.BigInt, userId)
        .query('SELECT user_id, org_id, role FROM dbo.app_user_org WHERE user_id=@uid');
      return res.recordset.map(mapMember);
    },
    async setMember(userId, orgId, role) {
      const p = await getPool();
      await p.request()
        .input('uid', sql.BigInt, userId)
        .input('oid', sql.BigInt, orgId)
        .input('role', sql.NVarChar(30), role || 'reporter')
        .query(`
          MERGE dbo.app_user_org AS t
          USING (SELECT @uid AS user_id, @oid AS org_id) AS s
            ON t.user_id = s.user_id AND t.org_id = s.org_id
          WHEN MATCHED THEN UPDATE SET role = @role
          WHEN NOT MATCHED THEN INSERT (user_id, org_id, role) VALUES (@uid, @oid, @role);
        `);
      return { user_id: userId, org_id: orgId, role: role || 'reporter' };
    },
    async removeMember(userId, orgId) {
      const p = await getPool();
      const res = await p.request()
        .input('uid', sql.BigInt, userId)
        .input('oid', sql.BigInt, orgId)
        .query('DELETE FROM dbo.app_user_org WHERE user_id=@uid AND org_id=@oid');
      return (res.rowsAffected[0] || 0) > 0;
    },
    async allMembers() {
      const p = await getPool();
      const res = await p.request().query('SELECT user_id, org_id, role FROM dbo.app_user_org');
      return res.recordset.map(mapMember);
    },
  };
}
