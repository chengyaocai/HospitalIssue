import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { authenticate } from '../auth/middleware.js';
import { requirePermission } from '../auth/authorize.js';
import { audit } from '../audit/index.js';
import {
  listConversations, getOrCreateAiConversation, createConversation,
  getConversation, listMessages, addMessage, markRead, unreadTotal,
  getMessage, recallMessage, deleteConversation, leaveConversation,
} from '../chat/index.js';
import { getRepo } from '../db/index.js';
import { generateReply } from '../services/aiAdapter.js';
import { config } from '../config.js';
import { upload, repairMojibakeName } from '../services/uploads.js';
import { membersWithUser } from '../orgs/index.js';
import { send500, sendError } from '../errors.js';

const router = express.Router();

// 收/看自己的会话与消息只需登录；创建与会话内发消息需「使用聊天」功能权限。
router.use(authenticate);

// 磁盘存储文件名 = 24 位随机 hex（uploads.js 生成）+ 可选扩展名；严格校验防路径穿越。
const STORED_RE = /^[a-f0-9]{24}(\.[A-Za-z0-9]{1,12})?$/;

// 仅保留结构合法的附件项（最多 10 个），防止前端传入任意内容。
function sanitizeAttachments(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((a) => ({
      id: String((a && a.id) || crypto.randomUUID()),
      originalName: repairMojibakeName(String((a && a.originalName) || 'file')).slice(0, 200),
      storedName: String((a && a.storedName) || ''),
      size: Number(a && a.size) || 0,
      type: String((a && a.type) || ''),
    }))
    .filter((a) => STORED_RE.test(a.storedName))
    .slice(0, 10);
}

// 会话访问守卫（多机构 v1.18 + 成员校验）：
// - 归属机构与当前机构不一致 → 按「不存在」处理（不泄漏跨机构会话的存在性）；
// - AI 会话仅发起者本人可访问；同事会话仅成员可访问。
// 返回 { conv } 或 { status, error }。
// 注：v1.18.14 的两个新端点（撤回 / 移除会话）会把这里的 403「不可见」收敛为 404，
// 但既有读/写接口保持本守卫原行为不变（api.test.mjs 钉死了非成员 403 文案）。
async function guardConversation(req) {
  const conv = await getConversation(req.params.id);
  if (!conv) return { status: 404, error: '会话不存在' };
  if (Number(conv.org_id == null ? 1 : conv.org_id) !== Number(req.orgId)) {
    return { status: 404, error: '会话不存在' };
  }
  const me = req.user.username;
  if (conv.type === 'ai') {
    return conv.created_by === me ? { conv } : { status: 403, error: '只能与自己发起的 AI 助手会话对话' };
  }
  const members = Array.isArray(conv.members) ? conv.members : [];
  return members.includes(me) ? { conv } : { status: 403, error: '非会话成员不能访问该会话' };
}

// 注意：静态路径（/unread、/ai）必须在 /conversations/:id 之前声明。
router.get('/unread', async (req, res) => {
  try {
    res.json({ total: await unreadTotal(req.user.username, req.orgId) });
  } catch (e) { send500(res, e); }
});

// 确保并返回当前用户的「AI 智能助手」会话（不存在则创建）。
router.get('/ai', async (req, res) => {
  try {
    res.json(await getOrCreateAiConversation(req.user.username, req.orgId));
  } catch (e) { send500(res, e); }
});

router.get('/conversations', async (req, res) => {
  try {
    res.json(await listConversations(req.user.username, req.orgId));
  } catch (e) { send500(res, e); }
});

// 新建会话（同事间）：members 为用户名数组；创建人自动加入。
// 成员必须都是「当前机构的成员」，避免跨机构建会话造成信息外泄。
router.post('/conversations', requirePermission('chat.use'), async (req, res) => {
  try {
    const { type, members, title } = req.body || {};
    const arr = Array.isArray(members) ? members : (typeof members === 'string' && members ? [members] : []);
    const clean = [...new Set(arr.map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (type === 'user' && clean.length < 1) {
      return res.status(400).json({ error: '请至少选择 1 位会话成员' });
    }
    if (type !== 'ai' && clean.length) {
      const known = new Set((await membersWithUser(req.orgId)).map((u) => u.username));
      const outside = clean.filter((u) => !known.has(u));
      if (outside.length) {
        return res.status(400).json({ error: `以下用户不属于本机构，无法加入会话：${outside.join('、')}` });
      }
    }
    const conv = await createConversation({
      type: type === 'ai' ? 'ai' : 'user',
      members: clean,
      title,
      created_by: req.user.username,
      org_id: req.orgId,
    });
    await audit({ username: req.user.username, action: 'CREATE_CHAT', target: 'conv#' + conv.id, detail: conv.title });
    res.status(201).json(conv);
  } catch (e) { sendError(res, e); }
});

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const g = await guardConversation(req);
    if (!g.conv) return res.status(g.status).json({ error: g.error });
    const msgs = await listMessages(g.conv.id, {
      limit: Number(req.query.limit) || 50,
      before: req.query.before || undefined,
    });
    res.json(msgs);
  } catch (e) { send500(res, e); }
});

// 发送消息：同事会话直接落库；AI 会话额外调用适配器生成助手回复。
// v1.18.22：支持「引用问题」—— 仅认 req.body.ref.id，快照 {id,title,status} 由后端从问题库读取，
// 不信任客户端传的 title/status；引用指向不存在 / 其它机构问题统一 400「引用的问题不存在」（不泄漏存在性）。
router.post('/conversations/:id/messages', requirePermission('chat.use'), async (req, res) => {
  try {
    const g = await guardConversation(req);
    if (!g.conv) return res.status(g.status).json({ error: g.error });
    const conv = g.conv;
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const attachments = sanitizeAttachments(req.body?.attachments);

    // v1.18.22：解析并校验问题引用（仅认 ref.id；id 必须是数字/数字字符串，其余字段全部忽略）。
    let ref = null;
    if (req.body && req.body.ref != null) {
      const refId = Number(req.body.ref.id);
      if (!Number.isFinite(refId)) {
        return res.status(400).json({ error: '引用的问题不存在' });
      }
      const repo = await getRepo();
      // 跨机构按约定 404——但「引用参数错误」语义下返回 400 同文案，避免泄漏跨机构存在性。
      const rec = await repo.get(refId, req.orgId);
      if (!rec) {
        return res.status(400).json({ error: '引用的问题不存在' });
      }
      // 快照只取后端可信字段：id / title / status
      ref = { id: rec.id, title: rec.title, status: rec.status };
    }

    // 空消息判定：body、attachments、ref 三者皆空才 400。
    if (!body && !attachments.length && !ref) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }
    // 带引用时留言 body ≤500 字（普通消息仍 ≤4000）。
    const maxLen = ref ? 500 : 4000;
    if (body.length > maxLen) {
      return res.status(400).json({ error: ref ? '引用留言过长（≤500 字）' : '消息内容过长（≤4000 字）' });
    }

    const userMsg = await addMessage({ conversation_id: conv.id, sender: req.user.username, body, attachments, ref });
    const out = { user: userMsg, conversation: conv };

    if (conv.type === 'ai') {
      const history = await listMessages(conv.id, { limit: 20 });
      const reply = await generateReply(history);
      // AI 会话的 assistant 回复消息不带 ref（维持现状），本接口 ref 仅作用于用户消息
      out.assistant = await addMessage({ conversation_id: conv.id, sender: reply.sender, body: reply.body });
    }
    res.json(out);
  } catch (e) { sendError(res, e); }
});

// 上传聊天附件（需「使用聊天」权限）：先上传取回元数据，再随消息一起发送。
// 支持图片/文件；单文件 ≤20MB（复用全局 upload 中间件）。
router.post('/conversations/:id/attachments', requirePermission('chat.use'), upload.single('file'), async (req, res) => {
  try {
    const g = await guardConversation(req);
    if (!g.conv) return res.status(g.status).json({ error: g.error });
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const originalName = repairMojibakeName(req.file.originalname);
    const att = {
      id: crypto.randomUUID(),
      originalName,
      storedName: req.file.filename,
      size: req.file.size,
      type: req.file.mimetype || '',
    };
    await audit({ username: req.user.username, action: 'UPLOAD_CHAT_ATTACHMENT', target: 'conv#' + g.conv.id, detail: originalName });
    res.status(201).json(att);
  } catch (e) { send500(res, e); }
});

// 取回/预览聊天附件：登录即可，安全基线同本项目既有附件（未登录拒绝 + 不可猜测随机文件名 + 严格文件名校验）。
// ?download=1 强制下载；默认 inline，图片可被 <img> 直接引用。
router.get('/attachments/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!STORED_RE.test(name)) return res.status(400).json({ error: '非法附件名' });
  const full = path.join(config.uploadsDir, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: '附件不存在' });
  if (req.query.download === '1') return res.download(full, name);
  res.sendFile(full);
});

// 标记会话内「他人发来」的消息为已读（幂等）。
router.put('/conversations/:id/read', async (req, res) => {
  try {
    const g = await guardConversation(req);
    if (!g.conv) return res.status(g.status).json({ error: g.error });
    const n = await markRead(g.conv.id, req.user.username);
    res.json({ ok: true, updated: n });
  } catch (e) { send500(res, e); }
});

// 撤回消息（v1.18.14，v1.18.33 放宽）：只需登录（撤回/退出是个人内容操作，与「看聊天只需登录」一致，
// 不加 chat.use）。守卫顺序：会话不存在或不可见 → 一律 404「会话不存在」（不泄漏存在性；
// 仅本端点把 guard 的 403「不可见」收敛为 404，既有接口守卫行为不变）→ 消息不存在 404。
// 权限（v1.18.33）：会话成员可撤回会话内**任何消息**（含对方发送的）——走到此处必为成员
//（AI 会话经 guard 已收敛为仅属主）。幂等：已撤回再撤回仍 200。
router.post('/conversations/:id/messages/:mid/recall', async (req, res) => {
  try {
    const g = await guardConversation(req);
    if (!g.conv) return res.status(404).json({ error: '会话不存在' });
    const conv = g.conv;
    const msg = await getMessage(conv.id, req.params.mid);
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    await recallMessage(conv.id, msg.id);
    res.json({ ok: true });
  } catch (e) { send500(res, e); }
});

// 移除会话（v1.18.14）：只需登录。语义按会话类型区分：
// - AI 会话 = 删除（仅属主可删，他人一律 404 不泄漏存在性）；删除后下次发消息会自动重建（既有行为）。
// - 同事会话 = 退出（仅成员可退，调用后本人不再可见，其他成员不受影响）；
//   最后一名成员退出时会话与消息整体删除。
router.delete('/conversations/:id', async (req, res) => {
  try {
    const conv = await getConversation(req.params.id);
    const me = req.user.username;
    if (!conv || Number(conv.org_id == null ? 1 : conv.org_id) !== Number(req.orgId)) {
      return res.status(404).json({ error: '会话不存在' });
    }
    if (conv.type === 'ai') {
      if (conv.created_by !== me) return res.status(404).json({ error: '会话不存在' });
      const ok = await deleteConversation(conv.id);
      if (!ok) return res.status(404).json({ error: '会话不存在' });
      return res.json({ ok: true, removed: 'all' });
    }
    const members = Array.isArray(conv.members) ? conv.members : [];
    if (!members.includes(me)) return res.status(404).json({ error: '会话不存在' });
    const r = await leaveConversation(conv.id, me);
    if (!r) return res.status(404).json({ error: '会话不存在' });
    return res.json({ ok: true, removed: r.removed });
  } catch (e) { send500(res, e); }
});

export default router;
