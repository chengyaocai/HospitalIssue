import fs from 'node:fs/promises';
import path from 'node:path';
import { filterByOrg, inOrg, DEFAULT_ORG_ID } from '../db/orgScope.js';

// dev / 测试用：本地 JSON 文件聊天存储。
// 会话 conversation：{ id, org_id, type:'ai'|'user', title, members:[username], created_by, created_at, updated_at }
// 消息 message：{ id, conversation_id, sender, body, read_by:[username], created_at }
export function createDevChatStore(filePath) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      cache = JSON.parse(raw);
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      cache = { conversations: [], messages: [] };
      await fs.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf8');
    }
    if (!Array.isArray(cache.conversations)) cache.conversations = [];
    if (!Array.isArray(cache.messages)) cache.messages = [];
    return cache;
  }

  async function save(data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    cache = data;
  }

  const nextConvId = (db) => db.conversations.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0) + 1;
  const nextMsgId = (db) => db.messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
  const isMember = (conv, username) => Array.isArray(conv.members) && conv.members.includes(username);

  // v1.18.14：recalled 消息在存储出口即屏蔽正文与附件（墓碑式占位），
  // 路由与前端拿到的就是「已脱敏」数据，无需再判断泄露。
  // v1.18.22：ref（问题引用元数据）同样在出口统一输出；recalled 一并屏蔽。
  function mapMsg(m) {
    const base = {
      id: m.id,
      conversation_id: m.conversation_id,
      sender: m.sender,
      created_at: m.created_at,
    };
    if (m.recalled) return { ...base, recalled: true, body: '', attachments: [], read_by: [], ref: null };
    return {
      ...base,
      recalled: false,
      body: m.body,
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      read_by: Array.isArray(m.read_by) ? m.read_by : [],
      // ref 直接以对象存储（dev/JSON 驱动）；无引用时为 null
      ref: (m.ref && typeof m.ref === 'object') ? m.ref : null,
    };
  }

  // 把会话附带「最近一条消息」与「当前用户未读数」后返回（供列表展示）。
  function summarize(db, conv, username) {
    const msgs = db.messages.filter((m) => String(m.conversation_id) === String(conv.id));
    const last = msgs[msgs.length - 1];
    const unread = msgs.filter(
      (m) => m.sender !== username && !(m.read_by || []).includes(username)
    ).length;
    return {
      id: conv.id,
      type: conv.type,
      title: conv.title,
      members: conv.members,
      created_by: conv.created_by,
      updated_at: conv.updated_at || conv.created_at,
      // v1.18.22：最后一条消息若是问题引用，则预览为「[问题引用] + 标题」；
      // recalled 消息仍显示空（墓碑逻辑已在 mapMsg 落位，这里直接判 recalled）。
      lastMessage: last
        ? (last.recalled ? '' : ((last.ref && typeof last.ref === 'object') ? `[问题引用] ${last.ref.title || ''}` : (last.body || ((last.attachments || []).length ? '[附件]' : ''))))
        : '',
      lastAt: last ? last.created_at : conv.created_at,
      unread,
    };
  }

  return {
    async getOrCreateAiConversation(username, orgId) {
      const db = await load();
      let conv = db.conversations.find((c) => c.type === 'ai' && c.created_by === username && inOrg(c, orgId));
      if (!conv) {
        const now = new Date().toISOString();
        conv = {
          id: nextConvId(db),
          org_id: orgId == null ? DEFAULT_ORG_ID : Number(orgId),
          type: 'ai', title: 'AI 智能助手',
          members: [username], created_by: username, created_at: now, updated_at: now,
        };
        db.conversations.push(conv);
        await save(db);
      }
      return conv;
    },
    async createConversation({ type, members, title, created_by, org_id } = {}) {
      const db = await load();
      const set = new Set((members || []).map((s) => String(s ?? '').trim()).filter(Boolean));
      const creator = String(created_by || '').trim();
      if (creator) set.add(creator);
      const memberArr = [...set];
      const now = new Date().toISOString();
      const conv = {
        id: nextConvId(db),
        // 机构归属（v1.18）：缺省落默认机构
        org_id: org_id == null ? DEFAULT_ORG_ID : Number(org_id),
        type: type || 'user',
        title: title && String(title).trim() ? String(title).trim() : memberArr.join('、'),
        members: memberArr,
        created_by: creator,
        created_at: now,
        updated_at: now,
      };
      db.conversations.push(conv);
      await save(db);
      return conv;
    },
    async getConversation(id) {
      const db = await load();
      return db.conversations.find((c) => String(c.id) === String(id)) || null;
    },
    async listConversations(username, orgId) {
      const db = await load();
      return filterByOrg(db.conversations, orgId)
        .filter((c) => (c.type === 'ai' ? c.created_by === username : isMember(c, username)))
        .map((c) => summarize(db, c, username))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    },
    async listMessages(convId, { limit = 50, before } = {}) {
      const db = await load();
      let msgs = db.messages.filter((m) => String(m.conversation_id) === String(convId));
      if (before) msgs = msgs.filter((m) => String(m.created_at) < String(before));
      msgs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return msgs.slice(-Number(limit)).map(mapMsg);
    },
    async addMessage({ conversation_id, sender, body, attachments, ref }) {
      const db = await load();
      const now = new Date().toISOString();
      const msg = {
        id: nextMsgId(db),
        conversation_id: Number(conversation_id),
        sender: String(sender),
        body: String(body || ''),
        attachments: Array.isArray(attachments) ? attachments : [],
        // v1.18.22：问题引用元数据（对象或 null），由路由层快照后传入，dev 直接存对象
        ref: (ref && typeof ref === 'object') ? ref : null,
        read_by: [],
        recalled: false, // v1.18.14：撤回标记，缺省 false
        created_at: now,
      };
      db.messages.push(msg);
      const conv = db.conversations.find((c) => c.id === Number(conversation_id));
      if (conv) conv.updated_at = now;
      await save(db);
      return msg;
    },
    async markRead(convId, username) {
      const db = await load();
      let n = 0;
      for (const m of db.messages) {
        if (String(m.conversation_id) !== String(convId)) continue;
        if (m.sender === username) continue;
        if (!Array.isArray(m.read_by)) m.read_by = [];
        if (!m.read_by.includes(username)) { m.read_by.push(username); n++; }
      }
      if (n) await save(db);
      return n;
    },
    // v1.18.14：取单条消息（含 sender，供撤回权限判定；已撤回的同样返回墓碑形态）
    async getMessage(convId, msgId) {
      const db = await load();
      const m = db.messages.find(
        (x) => String(x.conversation_id) === String(convId) && String(x.id) === String(msgId)
      );
      return m ? mapMsg(m) : null;
    },
    // v1.18.14：撤回消息（幂等：已撤回直接成功）。找不到返回 null。
    async recallMessage(convId, msgId) {
      const db = await load();
      const m = db.messages.find(
        (x) => String(x.conversation_id) === String(convId) && String(x.id) === String(msgId)
      );
      if (!m) return null;
      if (!m.recalled) { m.recalled = true; await save(db); }
      return true;
    },
    // v1.18.14：删除会话 + 该会话全部消息（AI 会话移除用）。找不到返回 null。
    async deleteConversation(id) {
      const db = await load();
      const idx = db.conversations.findIndex((c) => String(c.id) === String(id));
      if (idx < 0) return null;
      db.conversations.splice(idx, 1);
      db.messages = db.messages.filter((m) => String(m.conversation_id) !== String(id));
      await save(db);
      return true;
    },
    // v1.18.14：从会话成员中移除自己（同事会话退出用）。
    // 移除后成员为空 → 会话与消息整体删除（等价 deleteConversation）。
    // 非成员 / 会话不存在返回 null。
    async leaveConversation(id, username) {
      const db = await load();
      const conv = db.conversations.find((c) => String(c.id) === String(id));
      if (!conv) return null;
      const members = Array.isArray(conv.members) ? conv.members : [];
      if (!members.includes(username)) return null;
      const rest = members.filter((m) => m !== username);
      if (!rest.length) {
        db.conversations = db.conversations.filter((c) => String(c.id) !== String(id));
        db.messages = db.messages.filter((m) => String(m.conversation_id) !== String(id));
        await save(db);
        return { removed: 'all' };
      }
      conv.members = rest;
      await save(db);
      return { removed: 'self' };
    },
    async unreadTotal(username, orgId) {
      const db = await load();
      const convIds = new Set(
        filterByOrg(db.conversations, orgId)
          .filter((c) => (c.type === 'ai' ? c.created_by === username : isMember(c, username)))
          .map((c) => c.id)
      );
      return db.messages.filter(
        (m) => convIds.has(m.conversation_id) && m.sender !== username && !(m.read_by || []).includes(username)
      ).length;
    },
  };
}
