import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import problemsRouter from './routes/problems.js';
import authRouter from './routes/auth.js';
import attachmentsRouter from './routes/attachments.js';
import usersRouter from './routes/users.js';
import auditRouter from './routes/audit.js';
import settingsRouter from './routes/settings.js';
import notificationsRouter from './routes/notifications.js';
import schedulesRouter from './routes/schedules.js';
import chatRouter from './routes/chat.js';
import orgsRouter from './routes/orgs.js';
import timesheetRouter from './routes/timesheet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
// JSON 解析错误统一中文提示（如请求体非法 JSON）
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: '请求体不是合法的 JSON，请检查后重试' });
  }
  next(err);
});
app.use('/api', settingsRouter);
app.use('/api/auth', authRouter);
app.use('/api/problems', attachmentsRouter);
app.use('/api/users', usersRouter);
app.use('/api/audit', auditRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/chat', chatRouter);
app.use('/api/orgs', orgsRouter);
app.use('/api/timesheet', timesheetRouter);
app.use('/api', problemsRouter);

// 生产环境：托管前端构建产物（frontend/dist）
const distDir = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: '接口不存在' });
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// 兜底 404（前端未构建时 API 路径也会走到这里）
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// 全局错误兜底：原始错误只进日志，对外统一中文
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server]', err && err.stack ? err.stack : err);
  if (err && err.code && String(err.code).startsWith('LIMIT_')) {
    // multer 上传类错误（文件过大/数量超限等）
    const zh = {
      LIMIT_FILE_SIZE: '上传文件过大，超出大小限制',
      LIMIT_FILE_COUNT: '上传文件数量超出限制',
      LIMIT_UNEXPECTED_FILE: '上传的文件字段不符合要求',
    };
    return res.status(400).json({ error: zh[err.code] || '上传失败，请检查文件后重试' });
  }
  const msg = (err && err.message) || '';
  const error = msg.includes('数据库连接失败')
    ? msg
    : '服务器内部错误，请稍后重试或联系管理员';
  res.status(err && err.status ? err.status : 500).json({ error });
});

app.listen(config.port, () => {
  console.log(`[issue-tracker] listening on http://localhost:${config.port}  driver=${config.dbDriver}`);
});
