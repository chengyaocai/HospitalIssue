import sql from 'mssql';

// 生产用：SQL Server 消息通知表。
export function createMssqlNotificationStore(cfg) {
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
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_notification')
      BEGIN
        CREATE TABLE dbo.app_notification (
          id          BIGINT IDENTITY(1,1) PRIMARY KEY,
          title       NVARCHAR(200) NOT NULL,
          body        NVARCHAR(MAX),
          from_user   NVARCHAR(50),
          to_user     NVARCHAR(50),
          broadcast   BIT NOT NULL DEFAULT 0,
          is_read     BIT NOT NULL DEFAULT 0,
          created_at  DATETIME NOT NULL DEFAULT GETDATE()
        );
        CREATE INDEX ix_app_notification_to ON dbo.app_notification(to_user, is_read);
      END
    `);
    // 多机构（v1.18 增量迁移）：通知归属机构，默认 1（默认机构）。
    try {
      await pool.request().query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_notification') AND name = N'org_id') ALTER TABLE dbo.app_notification ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;`);
    } catch { /* 容忍列已存在等情况 */ }
  }

  // 数据库列名 -> 统一字段名（与 devNotificationStore 完全一致）。
  const map = (r) => ({
    id: r.id,
    org_id: r.org_id == null ? 1 : Number(r.org_id),
    title: r.title,
    body: r.body,
    from: r.from_user,
    to: r.to_user,
    broadcast: !!r.broadcast,
    read: !!r.is_read,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  });

  function bind(req, entry) {
    // 机构归属（v1.18）：缺省落默认机构
    req.input('org', sql.BigInt, entry.org_id == null ? 1 : Number(entry.org_id));
    req.input('title', sql.NVarChar(200), entry.title || '');
    req.input('body', sql.NVarChar(sql.MAX), entry.body || null);
    req.input('from', sql.NVarChar(50), entry.from || null);
    req.input('to', sql.NVarChar(50), entry.to || null);
    req.input('broadcast', sql.Bit, entry.broadcast === true ? 1 : 0);
  }

  const INSERT = 'INSERT INTO dbo.app_notification (org_id,title,body,from_user,to_user,broadcast) OUTPUT INSERTED.* VALUES (@org,@title,@body,@from,@to,@broadcast)';

  return {
    async add(entry) {
      const p = await getPool();
      const req = p.request();
      bind(req, entry);
      const res = await req.query(INSERT);
      return map(res.recordset[0]);
    },
    // 批量写入：一次事务内循环 INSERT，任一失败整体回滚。
    async addMany(entries) {
      const list = entries || [];
      if (!list.length) return [];
      const p = await getPool();
      const out = [];
      const tx = new sql.Transaction(p);
      await tx.begin();
      try {
        for (const entry of list) {
          const req = new sql.Request(tx);
          bind(req, entry);
          const res = await req.query(INSERT);
          out.push(map(res.recordset[0]));
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      return out;
    },
    async listForUser(username, { unread = false, limit = 50, orgId } = {}) {
      const p = await getPool();
      const orgCond = orgId != null ? ' AND org_id=@org' : '';
      const put = (r) => { r.input('user', sql.NVarChar(50), username); if (orgId != null) r.input('org', sql.BigInt, orgId); return r; };
      // unread 必须为「过滤前的未读总数」，不受 unread / limit 影响。
      const countReq = put(p.request());
      const countRes = await countReq.query(`SELECT COUNT(*) AS c FROM dbo.app_notification WHERE to_user=@user AND is_read=0${orgCond}`);
      const unreadTotal = countRes.recordset[0].c;

      const req = put(p.request());
      let where = 'WHERE to_user=@user';
      if (unread) where += ' AND is_read=0';
      if (orgId != null) where += ' AND org_id=@org';
      req.input('limit', sql.Int, Number(limit) || 50);
      const res = await req.query(`SELECT * FROM dbo.app_notification ${where} ORDER BY created_at DESC OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`);
      return { rows: res.recordset.map(map), unread: unreadTotal };
    },
    async unreadCount(username, orgId) {
      const p = await getPool();
      const req = p.request();
      req.input('user', sql.NVarChar(50), username);
      let where = 'to_user=@user AND is_read=0';
      if (orgId != null) { req.input('org', sql.BigInt, orgId); where += ' AND org_id=@org'; }
      const res = await req.query(`SELECT COUNT(*) AS c FROM dbo.app_notification WHERE ${where}`);
      return res.recordset[0].c;
    },
    // 先确认归属，再置已读：不属于该用户 / 不存在 -> false；已读再标一次 -> true（幂等）。
    async markRead(id, username, orgId) {
      const numId = Number(id);
      if (!Number.isFinite(numId)) return false;
      const p = await getPool();
      const orgCond = orgId != null ? ' AND org_id=@org' : '';
      const check = p.request();
      check.input('id', sql.BigInt, numId);
      check.input('user', sql.NVarChar(50), username);
      if (orgId != null) check.input('org', sql.BigInt, orgId);
      const found = await check.query(`SELECT id FROM dbo.app_notification WHERE id=@id AND to_user=@user${orgCond}`);
      if (!found.recordset.length) return false;
      const upd = p.request();
      upd.input('id', sql.BigInt, numId);
      upd.input('user', sql.NVarChar(50), username);
      if (orgId != null) upd.input('org', sql.BigInt, orgId);
      await upd.query(`UPDATE dbo.app_notification SET is_read=1 WHERE id=@id AND to_user=@user${orgCond}`);
      return true;
    },
    async markAllRead(username, orgId) {
      const p = await getPool();
      const req = p.request();
      req.input('user', sql.NVarChar(50), username);
      let where = 'to_user=@user AND is_read=0';
      if (orgId != null) { req.input('org', sql.BigInt, orgId); where += ' AND org_id=@org'; }
      const res = await req.query(`UPDATE dbo.app_notification SET is_read=1 WHERE ${where}`);
      return res.rowsAffected[0] || 0;
    },
  };
}
