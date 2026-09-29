import sql from 'mssql';

// 生产用：SQL Server 聊天存储（会话 + 消息两张表）。
// members / read_by 以 JSON 数组字符串存储（NVARCHAR(MAX)），读写时与数组互转。
// 成员关系判定使用 OPENJSON，避免字符串模糊匹配导致的误判。
export function createMssqlChatStore(cfg) {
  let pool;
  async function getPool() {
    if (!pool) {
      pool = await new sql.ConnectionPool(cfg).connect();
      await initTables();
    }
    return pool;
  }
  async function initTables() {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_chat_conversation')
      BEGIN
        CREATE TABLE dbo.app_chat_conversation (
          id          BIGINT IDENTITY(1,1) PRIMARY KEY,
          type        NVARCHAR(10) NOT NULL,
          title       NVARCHAR(200),
          members     NVARCHAR(MAX),
          created_by  NVARCHAR(50),
          created_at  DATETIME NOT NULL DEFAULT GETDATE(),
          updated_at  DATETIME NOT NULL DEFAULT GETDATE()
        );
        CREATE INDEX ix_app_chat_conversation_upd ON dbo.app_chat_conversation(updated_at);
      END
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_chat_message')
      BEGIN
        CREATE TABLE dbo.app_chat_message (
          id               BIGINT IDENTITY(1,1) PRIMARY KEY,
          conversation_id  BIGINT NOT NULL,
          sender           NVARCHAR(50),
          body             NVARCHAR(MAX),
          read_by          NVARCHAR(MAX),
          attachments      NVARCHAR(MAX),     -- 附件元数据数组（JSON 字符串）
          created_at       DATETIME NOT NULL DEFAULT GETDATE()
        );
        CREATE INDEX ix_app_chat_message_conv ON dbo.app_chat_message(conversation_id, created_at);
      END
      -- v1.17 增量迁移：老库补 attachments 列（新库建表已含）
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_chat_message') AND name = N'attachments')
        ALTER TABLE dbo.app_chat_message ADD attachments NVARCHAR(MAX);
      -- v1.18 增量迁移（多机构）：会话归属机构，默认 1（默认机构）
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_chat_conversation') AND name = N'org_id')
        ALTER TABLE dbo.app_chat_conversation ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;
      -- v1.18.14 增量迁移：消息撤回标记（0=正常，1=已撤回），启动自动加列无需手工改库
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_chat_message') AND name = N'recalled')
        ALTER TABLE dbo.app_chat_message ADD recalled INT NOT NULL DEFAULT 0 WITH VALUES;
      -- v1.18.22 增量迁移：消息问题引用元数据（JSON 字符串，存 {id,title,status} 快照），可空
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_chat_message') AND name = N'ref_json')
        ALTER TABLE dbo.app_chat_message ADD ref_json NVARCHAR(MAX) NULL;
    `);
  }

  // 行 -> 统一字段对象（与 devChatStore 完全一致）。
  const mapConv = (r) => ({
    id: r.id,
    org_id: r.org_id == null ? 1 : Number(r.org_id),
    type: r.type,
    title: r.title,
    members: safeParseArray(r.members),
    created_by: r.created_by,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  });
  // v1.18.14：recalled 消息在存储出口即屏蔽正文与附件（墓碑式占位），
  // 路由与前端拿到的就是「已脱敏」数据，无需再判断泄露。
  // v1.18.22：ref（问题引用元数据）同样在出口统一解析；recalled 一并屏蔽。
  const mapMsg = (r) => {
    const base = {
      id: r.id,
      conversation_id: r.conversation_id,
      sender: r.sender,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
    if (r.recalled) return { ...base, recalled: true, body: '', attachments: [], read_by: [], ref: null };
    return {
      ...base,
      recalled: false,
      body: r.body,
      read_by: safeParseArray(r.read_by),
      attachments: safeParseArray(r.attachments),
      ref: parseRef(r.ref_json),
    };
  };
  function safeParseArray(s) {
    if (Array.isArray(s)) return s;
    if (typeof s !== 'string' || !s) return [];
    try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  // v1.18.22：引用元数据（JSON 字符串 -> 对象）；非法/空 -> null
  function parseRef(s) {
    if (typeof s !== 'string' || !s) return null;
    try { const o = JSON.parse(s); return (o && typeof o === 'object') ? o : null; } catch { return null; }
  }

  // 当前用户可见的会话（ai：本人创建；user：members 含本人）。
  // 多机构（v1.18）：额外限定会话归属机构；@user / @org 由本函数统一注册，
  // 调用方严禁再对同一 request 重复 input 同名参数（否则 mssql 报「参数已声明」）。
  function memberWhere(req, user, orgId) {
    req.input('user', sql.NVarChar(50), user);
    let cond = `((type='ai' AND created_by=@user) OR (type='user' AND EXISTS(SELECT 1 FROM OPENJSON(members) WHERE value=@user)))`;
    if (orgId != null) {
      req.input('org', sql.BigInt, orgId);
      cond = `(${cond} AND org_id=@org)`;
    }
    return cond;
  }

  return {
    async getOrCreateAiConversation(username, orgId) {
      const p = await getPool();
      const sel = p.request();
      sel.input('user', sql.NVarChar(50), username);
      let where = "type='ai' AND created_by=@user";
      if (orgId != null) { sel.input('org', sql.BigInt, orgId); where += ' AND org_id=@org'; }
      const found = await sel.query(`SELECT * FROM dbo.app_chat_conversation WHERE ${where}`);
      if (found.recordset.length) return mapConv(found.recordset[0]);
      const now = new Date();
      const ins = p.request();
      ins.input('user', sql.NVarChar(50), username);
      ins.input('members', sql.NVarChar(sql.MAX), JSON.stringify([username]));
      ins.input('now', sql.DateTime, now);
      ins.input('org', sql.BigInt, orgId == null ? 1 : Number(orgId));
      const res = await ins.query(
        "INSERT INTO dbo.app_chat_conversation (org_id,type,title,members,created_by,created_at,updated_at) OUTPUT INSERTED.* VALUES (@org,'ai',N'AI 智能助手',@members,@user,@now,@now)"
      );
      return mapConv(res.recordset[0]);
    },
    async createConversation({ type, members, title, created_by, org_id } = {}) {
      const p = await getPool();
      const set = new Set((members || []).map((s) => String(s ?? '').trim()).filter(Boolean));
      const creator = String(created_by || '').trim();
      if (creator) set.add(creator);
      const memberArr = [...set];
      const t = title && String(title).trim() ? String(title).trim() : memberArr.join('、');
      const now = new Date();
      const req = p.request();
      // 机构归属（v1.18）：缺省落默认机构
      req.input('org', sql.BigInt, org_id == null ? 1 : Number(org_id));
      req.input('type', sql.NVarChar(10), type || 'user');
      req.input('title', sql.NVarChar(200), t);
      req.input('members', sql.NVarChar(sql.MAX), JSON.stringify(memberArr));
      req.input('creator', sql.NVarChar(50), creator);
      req.input('now', sql.DateTime, now);
      const res = await req.query(
        "INSERT INTO dbo.app_chat_conversation (org_id,type,title,members,created_by,created_at,updated_at) OUTPUT INSERTED.* VALUES (@org,@type,@title,@members,@creator,@now,@now)"
      );
      return mapConv(res.recordset[0]);
    },
    async getConversation(id) {
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, Number(id));
      const res = await req.query('SELECT * FROM dbo.app_chat_conversation WHERE id=@id');
      return res.recordset.length ? mapConv(res.recordset[0]) : null;
    },
    async listConversations(username, orgId) {
      const p = await getPool();
      const sel = p.request();
      const where = memberWhere(sel, username, orgId);
      const convs = (await sel.query(`SELECT * FROM dbo.app_chat_conversation WHERE ${where}`)).recordset.map(mapConv);
      const out = [];
      for (const c of convs) {
        const lastReq = p.request();
        lastReq.input('id', sql.BigInt, c.id);
        const lastRes = await lastReq.query(
          'SELECT TOP 1 * FROM dbo.app_chat_message WHERE conversation_id=@id ORDER BY created_at DESC'
        );
        const last = lastRes.recordset[0];
        const unReq = p.request();
        unReq.input('id', sql.BigInt, c.id);
        unReq.input('user', sql.NVarChar(50), username);
        const unRes = await unReq.query(
          `SELECT COUNT(*) AS c FROM dbo.app_chat_message
           WHERE conversation_id=@id AND sender<>@user
             AND NOT EXISTS(SELECT 1 FROM OPENJSON(read_by) WHERE value=@user)`
        );
        out.push({
          ...c,
          // v1.18.22：最后一条消息若是问题引用，则预览为「[问题引用] + 标题」；
        // recalled 消息仍显示空（墓碑逻辑已在 mapMsg 落位，这里直接判 recalled）。
        lastMessage: last
          ? (last.recalled ? '' : ((last.ref_json && parseRef(last.ref_json)) ? `[问题引用] ${parseRef(last.ref_json).title || ''}` : (last.body || (safeParseArray(last.attachments).length ? '[附件]' : ''))))
          : '',
          lastAt: last ? new Date(last.created_at).toISOString() : c.created_at,
          unread: unRes.recordset[0].c,
        });
      }
      out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return out;
    },
    async listMessages(convId, { limit = 50, before } = {}) {
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, Number(convId));
      req.input('limit', sql.Int, Number(limit) || 50);
      let sqlText = 'SELECT * FROM dbo.app_chat_message WHERE conversation_id=@id';
      if (before) { req.input('before', sql.DateTime, new Date(before)); sqlText += ' AND created_at < @before'; }
      sqlText += ' ORDER BY created_at ASC OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY';
      const res = await req.query(sqlText);
      return res.recordset.map(mapMsg);
    },
    async addMessage({ conversation_id, sender, body, attachments, ref }) {
      const p = await getPool();
      const attJson = JSON.stringify(Array.isArray(attachments) ? attachments : []);
      // v1.18.22：问题引用元数据以 JSON 字符串存储（ref_json 列），无引用时为 null
      const refJson = (ref && typeof ref === 'object') ? JSON.stringify(ref) : null;
      const req = p.request();
      req.input('cid', sql.BigInt, Number(conversation_id));
      req.input('sender', sql.NVarChar(50), String(sender));
      req.input('body', sql.NVarChar(sql.MAX), String(body || ''));
      req.input('attachments', sql.NVarChar(sql.MAX), attJson);
      // 参数注册点唯一：本函数仅此一处 input，helper 未介入，不会与 @org/@user 冲突
      req.input('refjson', sql.NVarChar(sql.MAX), refJson);
      req.input('now', sql.DateTime, new Date());
      const res = await req.query(
        "INSERT INTO dbo.app_chat_message (conversation_id,sender,body,read_by,attachments,ref_json,created_at) OUTPUT INSERTED.* VALUES (@cid,@sender,@body,N'[]',@attachments,@refjson,@now)"
      );
      const upd = p.request();
      upd.input('cid', sql.BigInt, Number(conversation_id));
      upd.input('now', sql.DateTime, new Date());
      await upd.query('UPDATE dbo.app_chat_conversation SET updated_at=@now WHERE id=@cid');
      return mapMsg(res.recordset[0]);
    },
    async markRead(convId, username) {
      const p = await getPool();
      const sel = p.request();
      sel.input('id', sql.BigInt, Number(convId));
      sel.input('user', sql.NVarChar(50), username);
      const res = await sel.query(
        `SELECT * FROM dbo.app_chat_message
         WHERE conversation_id=@id AND sender<>@user
           AND NOT EXISTS(SELECT 1 FROM OPENJSON(read_by) WHERE value=@user)`
      );
      let n = 0;
      for (const row of res.recordset) {
        const arr = safeParseArray(row.read_by);
        if (!arr.includes(username)) arr.push(username);
        const upd = p.request();
        upd.input('mid', sql.BigInt, row.id);
        upd.input('rb', sql.NVarChar(sql.MAX), JSON.stringify(arr));
        await upd.query('UPDATE dbo.app_chat_message SET read_by=@rb WHERE id=@mid');
        n++;
      }
      return n;
    },
    // v1.18.14：取单条消息（含 sender，供撤回权限判定；已撤回的同样返回墓碑形态）
    async getMessage(convId, msgId) {
      const p = await getPool();
      const req = p.request();
      req.input('cid', sql.BigInt, Number(convId));
      req.input('mid', sql.BigInt, Number(msgId));
      const res = await req.query(
        'SELECT * FROM dbo.app_chat_message WHERE conversation_id=@cid AND id=@mid'
      );
      return res.recordset.length ? mapMsg(res.recordset[0]) : null;
    },
    // v1.18.14：撤回消息（幂等：已撤回直接成功）。找不到返回 null。
    async recallMessage(convId, msgId) {
      const p = await getPool();
      const sel = p.request();
      sel.input('cid', sql.BigInt, Number(convId));
      sel.input('mid', sql.BigInt, Number(msgId));
      const found = await sel.query(
        'SELECT id FROM dbo.app_chat_message WHERE conversation_id=@cid AND id=@mid'
      );
      if (!found.recordset.length) return null;
      const upd = p.request();
      upd.input('cid', sql.BigInt, Number(convId));
      upd.input('mid', sql.BigInt, Number(msgId));
      await upd.query('UPDATE dbo.app_chat_message SET recalled=1 WHERE conversation_id=@cid AND id=@mid');
      return true;
    },
    // v1.18.14：删除会话 + 该会话全部消息（AI 会话移除用）。找不到返回 null。
    async deleteConversation(id) {
      const p = await getPool();
      const sel = p.request();
      sel.input('id', sql.BigInt, Number(id));
      const found = await sel.query('SELECT id FROM dbo.app_chat_conversation WHERE id=@id');
      if (!found.recordset.length) return null;
      const delM = p.request();
      delM.input('id', sql.BigInt, Number(id));
      await delM.query('DELETE FROM dbo.app_chat_message WHERE conversation_id=@id');
      const delC = p.request();
      delC.input('id', sql.BigInt, Number(id));
      await delC.query('DELETE FROM dbo.app_chat_conversation WHERE id=@id');
      return true;
    },
    // v1.18.14：从会话成员中移除自己（同事会话退出用）。
    // 移除后成员为空 → 会话与消息整体删除（等价 deleteConversation）。
    // 非成员 / 会话不存在返回 null。
    async leaveConversation(id, username) {
      const p = await getPool();
      const sel = p.request();
      sel.input('id', sql.BigInt, Number(id));
      const res = await sel.query('SELECT * FROM dbo.app_chat_conversation WHERE id=@id');
      if (!res.recordset.length) return null;
      const members = safeParseArray(res.recordset[0].members);
      if (!members.includes(username)) return null;
      const rest = members.filter((m) => m !== username);
      if (!rest.length) {
        const delM = p.request();
        delM.input('id', sql.BigInt, Number(id));
        await delM.query('DELETE FROM dbo.app_chat_message WHERE conversation_id=@id');
        const delC = p.request();
        delC.input('id', sql.BigInt, Number(id));
        await delC.query('DELETE FROM dbo.app_chat_conversation WHERE id=@id');
        return { removed: 'all' };
      }
      const upd = p.request();
      upd.input('id', sql.BigInt, Number(id));
      upd.input('members', sql.NVarChar(sql.MAX), JSON.stringify(rest));
      await upd.query('UPDATE dbo.app_chat_conversation SET members=@members WHERE id=@id');
      return { removed: 'self' };
    },
    async unreadTotal(username, orgId) {
      const p = await getPool();
      const req = p.request();
      // memberWhere 内部已注册 @user / @org 参数，此处不可再重复 input（否则 mssql 报参数重名）
      const where = memberWhere(req, username, orgId);
      const res = await req.query(
        `SELECT COUNT(*) AS c FROM dbo.app_chat_message m
         JOIN dbo.app_chat_conversation c ON m.conversation_id=c.id
         WHERE (${where}) AND m.sender<>@user
           AND NOT EXISTS(SELECT 1 FROM OPENJSON(m.read_by) WHERE value=@user)`
      );
      return res.recordset[0].c;
    },
  };
}
