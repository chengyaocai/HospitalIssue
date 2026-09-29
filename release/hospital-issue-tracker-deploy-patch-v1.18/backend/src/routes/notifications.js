import express from 'express';
import { authenticate } from '../auth/middleware.js';
import { requirePermission } from '../auth/authorize.js';
import { audit } from '../audit/index.js';
import { listForUser, unreadCount, markRead, markAllRead, sendNotification } from '../notifications/index.js';
import { membersWithUser } from '../orgs/index.js';
import { send500, sendError } from '../errors.js';

const router = express.Router();

// 接收通知不需要任何权限——所有登录用户都要能收。
// 通知按当前机构隔离：只能看到 / 操作「本机构发给本人」的通知。
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const result = await listForUser(req.user.username, {
      unread: req.query.unread === '1',
      limit: Number(req.query.limit) || 50,
      orgId: req.orgId,
    });
    res.json(result);
  } catch (e) {
    send500(res, e);
  }
});

// 注意：静态路径必须在 /:id/read 之前声明。
router.get('/unread-count', async (req, res) => {
  try {
    res.json({ unread: await unreadCount(req.user.username, req.orgId) });
  } catch (e) {
    send500(res, e);
  }
});

router.put('/read-all', async (req, res) => {
  try {
    const updated = await markAllRead(req.user.username, req.orgId);
    res.json({ ok: true, updated });
  } catch (e) {
    send500(res, e);
  }
});

router.put('/:id/read', async (req, res) => {
  try {
    const ok = await markRead(req.params.id, req.user.username, req.orgId);
    // 不属于当前用户 / 不属于本机构的 id 一律 404，不泄漏别人的消息是否存在。
    if (!ok) return res.status(404).json({ error: '消息不存在' });
    res.json({ ok: true });
  } catch (e) {
    send500(res, e);
  }
});

// 发送给指定用户：需「发送通知」功能权限。接收人必须是「当前机构的成员」。
router.post('/', requirePermission('notification.send'), async (req, res) => {
  try {
    const { title, body, to } = req.body || {};
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t || t.length > 200) return res.status(400).json({ error: '标题必填（200 字以内）' });
    const b = typeof body === 'string' ? body : '';
    if (b.length > 2000) return res.status(400).json({ error: '内容不能超过 2000 字' });
    if (to === undefined || to === null || to === '') return res.status(400).json({ error: '接收对象必填' });
    if (to === 'all') return res.status(400).json({ error: '全员通知请使用全员发送接口' });

    const recipients = Array.isArray(to) ? to : [to];
    const unique = [...new Set(recipients.map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (!unique.length) return res.status(400).json({ error: '接收对象必填' });

    const known = new Set((await membersWithUser(req.orgId)).map((u) => u.username));
    for (const u of unique) {
      if (!known.has(u)) return res.status(400).json({ error: `接收用户不存在或不属于本机构：${u}` });
    }

    const { sent } = await sendNotification({ title: t, body: b, from: req.user.username, to: unique, orgId: req.orgId });
    await audit({ username: req.user.username, action: 'SEND_NOTIFICATION', target: unique.join(','), detail: t });
    res.json({ sent });
  } catch (e) {
    sendError(res, e);
  }
});

// 全员广播：需「发送全员通知」功能权限。接收人 = 当前机构内所有启用中的成员。
router.post('/broadcast', requirePermission('notification.broadcast'), async (req, res) => {
  try {
    const { title, body } = req.body || {};
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t || t.length > 200) return res.status(400).json({ error: '标题必填（200 字以内）' });
    const b = typeof body === 'string' ? body : '';
    if (b.length > 2000) return res.status(400).json({ error: '内容不能超过 2000 字' });

    const targets = (await membersWithUser(req.orgId)).filter((u) => u.active !== false).map((u) => u.username);
    const { sent } = await sendNotification({ title: t, body: b, from: req.user.username, to: targets, broadcast: true, orgId: req.orgId });
    await audit({ username: req.user.username, action: 'BROADCAST_NOTIFICATION', target: 'all', detail: t });
    res.json({ sent });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
