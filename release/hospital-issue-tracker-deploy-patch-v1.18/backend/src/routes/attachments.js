import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { getRepo } from '../db/index.js';
import { authenticate } from '../auth/middleware.js';
import { requirePermission } from '../auth/authorize.js';
import { config } from '../config.js';
import { upload, repairMojibakeName } from '../services/uploads.js';
import { audit } from '../audit/index.js';
import { send500 } from '../errors.js';

const router = express.Router();

// 上传附件（需「编辑问题」权限）
router.post('/:id/attachments', authenticate, requirePermission('issue.edit'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const repo = await getRepo();
    const rec = await repo.get(req.params.id);
    if (!rec) return res.status(404).json({ error: '未找到该问题' });
    // 统一清洗文件名编码（见 services/uploads.js）：乱码则还原，正常则原样保留
    const originalName = repairMojibakeName(req.file.originalname);
    const att = {
      id: crypto.randomUUID(),
      originalName,
      storedName: req.file.filename,
      size: req.file.size,
      uploadedBy: req.user.username,
      uploadedAt: new Date().toISOString(),
    };
    const attachments = Array.isArray(rec.attachments) ? rec.attachments : [];
    attachments.push(att);
    await repo.update(req.params.id, { attachments });
    await audit({ username: req.user.username, action: 'UPLOAD_ATTACHMENT', target: 'problem#' + req.params.id, detail: originalName });
    res.status(201).json(att);
  } catch (e) {
    send500(res, e);
  }
});

// 下载附件
router.get('/:id/attachments/:fileId', authenticate, async (req, res) => {
  try {
    const repo = await getRepo();
    const rec = await repo.get(req.params.id);
    if (!rec) return res.status(404).json({ error: '未找到该问题' });
    const att = (rec.attachments || []).find((a) => a.id === req.params.fileId);
    if (!att) return res.status(404).json({ error: '未找到附件' });
    res.download(path.join(config.uploadsDir, att.storedName), repairMojibakeName(att.originalName));
  } catch (e) {
    send500(res, e);
  }
});

// 删除附件（需「删除问题」权限）
router.delete('/:id/attachments/:fileId', authenticate, requirePermission('issue.delete'), async (req, res) => {
  try {
    const repo = await getRepo();
    const rec = await repo.get(req.params.id);
    if (!rec) return res.status(404).json({ error: '未找到该问题' });
    const att = (rec.attachments || []).find((a) => a.id === req.params.fileId);
    if (!att) return res.status(404).json({ error: '未找到附件' });
    const attachments = (rec.attachments || []).filter((a) => a.id !== req.params.fileId);
    await repo.update(req.params.id, { attachments });
    try { await fs.unlink(path.join(config.uploadsDir, att.storedName)); } catch {}
    await audit({ username: req.user.username, action: 'DELETE_ATTACHMENT', target: 'problem#' + req.params.id, detail: att.originalName });
    res.json({ ok: true });
  } catch (e) {
    send500(res, e);
  }
});

export default router;
