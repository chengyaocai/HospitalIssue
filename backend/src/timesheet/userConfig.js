// 按用户隔离的工时配置（v1.18.43）：每个公司用户登录「工时配置」界面维护自己的记录。
//   我的 WXP 账号（工号 + 密码，明文存——与既有 wxp.json 现状一致，密码接口层永不回显）
//   我的 PMIS-MCP token 令牌（v1.18.49）：配置后本人所有 PMIS 调用走自己的 token（覆盖全局 mcp.json）
//   填报默认值（类型 / 费用条线 / 工序 / 默认工时）
//   我的常用工时内容（v1.18.49）：个人维度内容池，随机填充优先用个人池，空则回落全局知识库
//   医院 → 在建项目绑定（个人维度；覆盖全局 Configs/timesheet.json 的同名绑定，未配置的医院回落全局）
// 存储键 = 用户账号（username；dev）或 user_id（mssql）。全局知识库保持共享。
// dev 驱动：data/timesheet-user.json（map: username -> cfg）；生产：表 app_user_ts_config（user_id PK）。

import fs from 'node:fs';
import path from 'node:path';
import sql from 'mssql';
import { config } from '../config.js';

const DEFAULTS_KEYS = ['timesheetType', 'costLineId', 'processType', 'workHours'];
const MAX_CONTENTS = 100; // 个人常用内容上限

function normToken(t) {
  return String(t || '').trim().replace(/^Bearer\s+/i, '').slice(0, 500);
}

function sanitize(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const out = { wxpUserCode: '', wxpPassword: '', pmisToken: '', contents: [], kbMode: 'all', defaults: {}, bindings: {} };
  if (typeof c.wxpUserCode === 'string') out.wxpUserCode = c.wxpUserCode.trim().slice(0, 50);
  if (typeof c.wxpPassword === 'string') out.wxpPassword = c.wxpPassword.slice(0, 100);
  if (typeof c.pmisToken === 'string') out.pmisToken = normToken(c.pmisToken);
  // 知识库加载模式：'all' = 个人内容池 + 全局知识库（默认）；'personal' = 仅个人内容池
  out.kbMode = c.kbMode === 'personal' ? 'personal' : 'all';
  if (Array.isArray(c.contents)) {
    out.contents = c.contents
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => x.trim().slice(0, 500))
      .slice(0, MAX_CONTENTS);
  }
  for (const k of DEFAULTS_KEYS) {
    const v = Number(c.defaults?.[k]);
    if (Number.isFinite(v) && v >= 0) out.defaults[k] = v;
  }
  if (c.bindings && typeof c.bindings === 'object' && !Array.isArray(c.bindings)) {
    for (const [code, b] of Object.entries(c.bindings)) {
      if (!b || typeof b !== 'object') continue;
      out.bindings[String(code).slice(0, 20)] = {
        hospitalName: String(b.hospitalName || '').slice(0, 100),
        inProjectId: Number(b.inProjectId) || 0,
        inProjectName: String(b.inProjectName || '').slice(0, 200),
      };
    }
  }
  return out;
}

// ---------- dev 驱动（JSON 文件） ----------

let devCache = null;
function devLoad() {
  if (devCache) return devCache;
  try {
    devCache = JSON.parse(fs.readFileSync(config.timesheetUserDevPath, 'utf8'));
  } catch {
    devCache = {};
  }
  if (!devCache || typeof devCache !== 'object' || Array.isArray(devCache)) devCache = {};
  return devCache;
}

function devSave(all) {
  fs.mkdirSync(path.dirname(config.timesheetUserDevPath), { recursive: true });
  fs.writeFileSync(config.timesheetUserDevPath, JSON.stringify(all, null, 2), 'utf8');
  devCache = all;
}

// ---------- mssql 驱动（表 app_user_ts_config） ----------

let pool;
async function getPool() {
  if (!pool) {
    pool = await new sql.ConnectionPool(config.mssql).connect();
    await initTable();
  }
  return pool;
}

async function initTable() {
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_user_ts_config')
    BEGIN
      CREATE TABLE dbo.app_user_ts_config (
        user_id BIGINT NOT NULL PRIMARY KEY,
        username NVARCHAR(50) NOT NULL,
        config_json NVARCHAR(MAX) NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT GETDATE()
      );
    END
  `);
}

async function mssqlGet(userId) {
  const p = await getPool();
  const req = p.request();
  req.input('uid', sql.BigInt, userId);
  const res = await req.query('SELECT config_json FROM dbo.app_user_ts_config WHERE user_id = @uid');
  if (!res.recordset.length) return null;
  try { return JSON.parse(res.recordset[0].config_json); } catch { return null; }
}

async function mssqlSave(userId, username, cfg) {
  const p = await getPool();
  const req = p.request();
  req.input('uid', sql.BigInt, userId);
  req.input('uname', sql.NVarChar(50), username || '');
  req.input('cfg', sql.NVarChar(sql.MAX), JSON.stringify(cfg));
  await req.query(`
    IF EXISTS (SELECT 1 FROM dbo.app_user_ts_config WHERE user_id = @uid)
      UPDATE dbo.app_user_ts_config SET config_json = @cfg, username = @uname, updated_at = GETDATE() WHERE user_id = @uid
    ELSE
      INSERT INTO dbo.app_user_ts_config (user_id, username, config_json) VALUES (@uid, @uname, @cfg)
  `);
}

// ---------- 对外 API ----------

/** 取某用户的个人配置；无记录返回 null */
export async function getUserTsConfig({ userId, username }) {
  if (config.dbDriver === 'dev') {
    const all = devLoad();
    return all[username] ? sanitize(all[username]) : null;
  }
  const raw = await mssqlGet(userId);
  return raw ? sanitize(raw) : null;
}

/** 保存某用户的个人配置（patch 语义：password 空串/缺省 = 保留原密码） */
export async function saveUserTsConfig({ userId, username }, patch) {
  const cur = (await getUserTsConfig({ userId, username })) || { wxpUserCode: '', wxpPassword: '', defaults: {}, bindings: {} };
  const next = sanitize(cur);
  if (typeof patch.wxpUserCode === 'string') next.wxpUserCode = patch.wxpUserCode.trim().slice(0, 50);
  if (typeof patch.wxpPassword === 'string' && patch.wxpPassword !== '') next.wxpPassword = patch.wxpPassword.slice(0, 100);
  // 个人 PMIS-MCP token：undefined/缺省 = 保留；'' 或 null = 清除（回落全局 mcp.json）；非空 = 设置
  if (typeof patch.pmisToken === 'string') next.pmisToken = normToken(patch.pmisToken);
  else if (patch.pmisToken === null) next.pmisToken = '';
  // 个人常用工时内容：传数组 = 全量替换（去空去重，截断 500 字，上限 100 条）
  if (Array.isArray(patch.contents)) {
    const seen = new Set();
    next.contents = patch.contents
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => x.trim().slice(0, 500))
      .filter((x) => (seen.has(x) ? false : (seen.add(x), true)))
      .slice(0, MAX_CONTENTS);
  }
  // 知识库加载模式：仅接受 'personal' / 'all'，其他值忽略保留原值
  if (patch.kbMode === 'personal' || patch.kbMode === 'all') next.kbMode = patch.kbMode;
  if (patch.defaults && typeof patch.defaults === 'object') {
    for (const k of DEFAULTS_KEYS) {
      const v = Number(patch.defaults[k]);
      if (Number.isFinite(v) && v >= 0) next.defaults[k] = v;
      else if (patch.defaults[k] === null) delete next.defaults[k];
    }
  }
  if (patch.bindings && typeof patch.bindings === 'object' && !Array.isArray(patch.bindings)) {
    for (const [code, b] of Object.entries(patch.bindings)) {
      const key = String(code).slice(0, 20);
      if (b === null) { delete next.bindings[key]; continue; } // null = 清除该医院绑定
      if (!b || typeof b !== 'object') continue;
      next.bindings[key] = {
        hospitalName: String(b.hospitalName || '').slice(0, 100),
        inProjectId: Number(b.inProjectId) || 0,
        inProjectName: String(b.inProjectName || '').slice(0, 200),
      };
    }
  }
  next.updatedAt = new Date().toISOString();
  if (config.dbDriver === 'dev') {
    const all = devLoad();
    all[username] = next;
    devSave(all);
  } else {
    await mssqlSave(userId, username, next);
  }
  return sanitize(next);
}

/** 对外形态：密码 / token 永不回显（只给 hasPassword / hasToken）；contents 回显全文 */
export function publicTsConfig(cfg) {
  if (!cfg) return null;
  return {
    wxpUserCode: cfg.wxpUserCode || '',
    hasPassword: Boolean(cfg.wxpPassword),
    hasToken: Boolean(cfg.pmisToken),
    contents: [...(cfg.contents || [])],
    kbMode: cfg.kbMode === 'personal' ? 'personal' : 'all',
    defaults: { ...(cfg.defaults || {}) },
    bindings: { ...(cfg.bindings || {}) },
    updatedAt: cfg.updatedAt || null,
  };
}
