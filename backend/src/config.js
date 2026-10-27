import dotenv from 'dotenv';
dotenv.config();

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT) || 3000,
  dbDriver: (process.env.DB_DRIVER || 'mssql').toLowerCase(),
  devDbPath: process.env.DEV_DB_PATH || path.join(__dirname, '..', 'data', 'issues.json'),
  devUsersPath: process.env.DEV_USERS_PATH || path.join(__dirname, '..', 'data', 'users.json'),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  adminUsername: process.env.ADMIN_USER || 'admin',
  adminName: process.env.ADMIN_NAME || '系统管理员',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  // v1.18.75：强制解析为绝对路径 —— express res.sendFile/res.download 要求绝对路径，
  // 相对值（如 UPLOADS_DIR=uploads）会让 fs.stat/multer 按 CWD 成功而 sendFile 抛
  // 「path must be absolute or specify root」。按 CWD 解析保持与既有磁盘文件位置一致，
  // 服务器 .env 无需任何改动；绝对值原样保留，未配置时仍默认 backend/uploads。
  uploadsDir: path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads')),
  auditDevPath: process.env.AUDIT_DEV_PATH || path.join(__dirname, '..', 'data', 'audit.json'),
  settingsDevPath: process.env.SETTINGS_DEV_PATH || path.join(__dirname, '..', 'data', 'settings.json'),
  notificationsDevPath: process.env.NOTIFICATIONS_DEV_PATH || path.join(__dirname, '..', 'data', 'notifications.json'),
  chatDevPath: process.env.CHAT_DEV_PATH || path.join(__dirname, '..', 'data', 'chat.json'),
  scheduleDevPath: process.env.SCHEDULE_DEV_PATH || path.join(__dirname, '..', 'data', 'schedules.json'),
  // 文件管理（v1.18.70）：dev 驱动落 JSON 文件；生产落表 dbo.app_file
  filesDevPath: process.env.FILES_DEV_PATH || path.join(__dirname, '..', 'data', 'files.json'),
  // 业务服务管理（v1.18.82）：dev 驱动落 JSON 文件；生产落表 dbo.app_service
  svcDevPath: process.env.SVC_DEV_PATH || path.join(__dirname, '..', 'data', 'services.json'),
  // 按用户隔离的工时配置（v1.18.43，dev 驱动落 JSON 文件；生产落表 app_user_ts_config）
  timesheetUserDevPath: process.env.TIMESHEET_USER_DEV_PATH || path.join(__dirname, '..', 'data', 'timesheet-user.json'),
  // 多机构（v1.18）：机构 / 成员关系（dev 驱动落 JSON 文件），以及首次启动自动创建的默认机构名称。
  orgsDevPath: process.env.ORGS_DEV_PATH || path.join(__dirname, '..', 'data', 'orgs.json'),
  defaultOrgName: process.env.DEFAULT_ORG_NAME || '默认机构',
  appName: process.env.APP_NAME || '医院信息科 · 软件问题登记',
  // 实施协同 · 工时登记（v1.18.42 原生集成）：业务逻辑全部在本系统内实现（src/timesheet/），
  // 凭据与医院绑定在 backend/Configs/ 4 份 JSON（timesheet/wxp/mcp/timesheet-kb.json，见 timesheet/configs.js）。
  roles: { ADMIN: 'admin', REPORTER: 'reporter' },
  mssql: {
    server: process.env.MSSQL_SERVER || 'localhost',
    port: Number(process.env.MSSQL_PORT) || 1433,
    database: process.env.MSSQL_DATABASE || 'HospitalIssue',
    user: process.env.MSSQL_USER || 'sa',
    password: process.env.MSSQL_PASSWORD || '',
    options: {
      encrypt: (process.env.MSSQL_ENCRYPT || 'false') === 'true',
      trustServerCertificate: (process.env.MSSQL_TRUST_CERT || 'true') === 'true',
    },
  },
};
