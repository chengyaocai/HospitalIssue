import sql from 'mssql';
import { hashPassword } from './password.js';

// 生产用：SQL Server 用户表仓库。
export function createMssqlUserStore(cfg) {
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
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_user')
      BEGIN
        CREATE TABLE dbo.app_user (
          id BIGINT IDENTITY(1,1) PRIMARY KEY,
          username NVARCHAR(50) NOT NULL UNIQUE,
          name NVARCHAR(100),
          role NVARCHAR(30) NOT NULL DEFAULT N'reporter',
          active BIT NOT NULL DEFAULT 1,
          is_platform_admin BIT NOT NULL DEFAULT 0,
          user_type NVARCHAR(16) NOT NULL DEFAULT N'hospital',
          phone NVARCHAR(20) NULL,
          password NVARCHAR(200) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT GETDATE()
        );
      END
      ELSE
      BEGIN
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'active')
          ALTER TABLE dbo.app_user ADD active BIT NOT NULL DEFAULT 1;
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'is_platform_admin')
          ALTER TABLE dbo.app_user ADD is_platform_admin BIT NOT NULL DEFAULT 0 WITH VALUES;
        -- 用户类型（v1.18.12）：'hospital'=院方 / 'company'=公司。
        -- 存量账号全部自动归为院方（WITH VALUES 平滑加列），业务守卫在路由层。
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'user_type')
          ALTER TABLE dbo.app_user ADD user_type NVARCHAR(16) NOT NULL DEFAULT N'hospital' WITH VALUES;
        -- 联系电话（v1.18.17）：账号级字段，可空。用于值班表 / 处理人联系。
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'phone')
          ALTER TABLE dbo.app_user ADD phone NVARCHAR(20) NULL;
        -- 最近登录时间（v1.18.44）：登录成功时更新（GETDATE()），可空=从未登录。用户管理列表展示用。
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'last_login_at')
          ALTER TABLE dbo.app_user ADD last_login_at DATETIME NULL;
        -- 角色 key 最长 30 位（自定义角色），把旧的 NVARCHAR(20) 平滑放宽到 NVARCHAR(30)。
        IF EXISTS (
          SELECT * FROM sys.columns c
          JOIN sys.types t ON c.user_type_id = t.user_type_id
          WHERE c.object_id = OBJECT_ID(N'dbo.app_user') AND c.name = N'role' AND c.max_length < 60
        )
          ALTER TABLE dbo.app_user ALTER COLUMN role NVARCHAR(30) NOT NULL;
      END
    `);
  }

  const map = (r) => (r ? {
    id: r.id,
    username: r.username,
    name: r.name,
    role: r.role,
    active: r.active !== false && r.active !== 0,
    platformAdmin: r.is_platform_admin === true || r.is_platform_admin === 1,
    userType: r.user_type === 'company' ? 'company' : 'hospital',
    phone: r.phone || '',
    password: r.password,
    // 最近登录时间（v1.18.44）：统一转 ISO 字符串（mssql 返回 Date，JSON 序列化前先归一）。
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  } : null);

  return {
    async ensureSeed(seed) {
      const p = await getPool();
      const cnt = await p.request().query('SELECT COUNT(*) AS c FROM dbo.app_user');
      if (cnt.recordset[0].c === 0) {
        const hashed = await hashPassword(seed.password);
        await p.request()
          .input('username', sql.NVarChar(50), seed.username)
          .input('name', sql.NVarChar(100), seed.name || seed.username)
          .input('role', sql.NVarChar(20), 'admin')
          .input('password', sql.NVarChar(200), hashed)
          .query('INSERT INTO dbo.app_user (username,name,role,active,is_platform_admin,password) VALUES (@username,@name,@role,1,1,@password)');
      }
    },
    async findByUsername(username) {
      const p = await getPool();
      const res = await p.request().input('username', sql.NVarChar(50), username).query('SELECT * FROM dbo.app_user WHERE username = @username');
      return map(res.recordset[0]);
    },
    async findById(id) {
      const p = await getPool();
      const res = await p.request().input('id', sql.BigInt, id).query('SELECT * FROM dbo.app_user WHERE id = @id');
      return map(res.recordset[0]);
    },
    async list() {
      const p = await getPool();
      const res = await p.request().query('SELECT id, username, name, role, active, is_platform_admin, user_type, phone, last_login_at FROM dbo.app_user ORDER BY id');
      return res.recordset.map((r) => ({
        id: r.id,
        username: r.username,
        name: r.name,
        role: r.role,
        active: r.active !== false && r.active !== 0,
        platformAdmin: r.is_platform_admin === true || r.is_platform_admin === 1,
        userType: r.user_type === 'company' ? 'company' : 'hospital',
        phone: r.phone || '',
        lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
      }));
    },
    async create({ username, name, role, password, userType, phone }) {
      const p = await getPool();
      const ex = await p.request().input('username', sql.NVarChar(50), username).query('SELECT id FROM dbo.app_user WHERE username = @username');
      if (ex.recordset.length) return null;
      const type = userType === 'company' ? 'company' : 'hospital';
      const ph = typeof phone === 'string' ? phone.trim() : '';
      const res = await p.request()
        .input('username', sql.NVarChar(50), username)
        .input('name', sql.NVarChar(100), name || username)
        .input('role', sql.NVarChar(30), role || 'reporter')
        .input('utype', sql.NVarChar(16), type)
        .input('phone', sql.NVarChar(20), ph)
        .input('password', sql.NVarChar(200), password)
        .query('INSERT INTO dbo.app_user (username,name,role,active,user_type,phone,password) OUTPUT INSERTED.id, INSERTED.username, INSERTED.name, INSERTED.role, INSERTED.user_type, INSERTED.phone VALUES (@username,@name,@role,1,@utype,@phone,@password)');
      const r = res.recordset[0];
      return { id: r.id, username: r.username, name: r.name, role: r.role, active: true, platformAdmin: false, userType: r.user_type === 'company' ? 'company' : 'hospital', phone: r.phone || '' };
    },
    async setPassword(id, hashed) {
      const p = await getPool();
      const res = await p.request().input('id', sql.BigInt, id).input('password', sql.NVarChar(200), hashed).query('UPDATE dbo.app_user SET password=@password WHERE id=@id');
      return res.rowsAffected[0] > 0;
    },
    async setActive(id, active) {
      const p = await getPool();
      const res = await p.request().input('id', sql.BigInt, id).input('active', sql.Bit, active ? 1 : 0).query('UPDATE dbo.app_user SET active=@active WHERE id=@id');
      return res.rowsAffected[0] > 0;
    },
    // 最近登录时间（v1.18.44）：登录成功即更新（GETDATE()）。只记「登录」事件——认证请求刷新的是在线状态。
    async touchLogin(id) {
      const p = await getPool();
      const res = await p.request().input('id', sql.BigInt, id).query('UPDATE dbo.app_user SET last_login_at = GETDATE() WHERE id = @id');
      return (res.rowsAffected[0] || 0) > 0;
    },
    // ⚠️ 写的是「全局角色」app_user.role。机构级接口（如 PUT /api/users/:id/role）不要调用它 ——
    // 全局角色是「无成员关系机构」的角色回落来源，回写会把本机构的改动泄漏到其它机构。
    // 机构内角色请用 orgs 存储的 setMember(userId, orgId, role)。见 v1.18.3。
    async setRole(id, role) {
      const p = await getPool();
      const res = await p.request()
        .input('id', sql.BigInt, id)
        .input('role', sql.NVarChar(30), role)
        .query('UPDATE dbo.app_user SET role=@role OUTPUT INSERTED.id, INSERTED.username, INSERTED.name, INSERTED.role, INSERTED.active, INSERTED.is_platform_admin, INSERTED.user_type WHERE id=@id');
      const r = res.recordset[0];
      if (!r) return false;
      return {
        id: r.id,
        username: r.username,
        name: r.name,
        role: r.role,
        active: r.active !== false && r.active !== 0,
        platformAdmin: r.is_platform_admin === true || r.is_platform_admin === 1,
        userType: r.user_type === 'company' ? 'company' : 'hospital',
      };
    },
    // 平台管理员标记（v1.18）：可跨机构管理。全局唯一，不属于任何单一机构。
    async setPlatformAdmin(id, flag) {
      const p = await getPool();
      const res = await p.request()
        .input('id', sql.BigInt, id)
        .input('flag', sql.Bit, flag ? 1 : 0)
        .query('UPDATE dbo.app_user SET is_platform_admin=@flag WHERE id=@id');
      return (res.rowsAffected[0] || 0) > 0;
    },
    // 用户类型（v1.18.12）：'hospital' | 'company'。多机构归属守卫由路由层负责。
    async setUserType(id, type) {
      const p = await getPool();
      const res = await p.request()
        .input('id', sql.BigInt, id)
        .input('utype', sql.NVarChar(16), type === 'company' ? 'company' : 'hospital')
        .query('UPDATE dbo.app_user SET user_type=@utype WHERE id=@id');
      return (res.rowsAffected[0] || 0) > 0;
    },
    // 联系电话（v1.18.17）：账号级、全局唯一字段。边界守卫（平台管理员 / 本机构专属账号）由路由层负责。
    async setPhone(id, phone) {
      const p = await getPool();
      const res = await p.request()
        .input('id', sql.BigInt, id)
        .input('phone', sql.NVarChar(20), typeof phone === 'string' ? phone.trim() : '')
        .query('UPDATE dbo.app_user SET phone=@phone WHERE id=@id');
      return (res.rowsAffected[0] || 0) > 0;
    },
  };
}
