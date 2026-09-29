// 工时登记配置读取（v1.18.42 原生集成）：读取 backend/Configs/ 下 4 份 JSON（从 WXP 系统原样移植）。
//   timesheet.json   工时默认值 / 类型字典 / 医院→在建项目绑定 / 进行中状态清单
//   wxp.json         WXP 底稿系统地址与账号（BaseUrl / UserCode / PasswordEncrypted / Api 路径）
//   mcp.json         PMIS-MCP 服务地址与 Authorization（Bearer 项目 token，过期换文件即可）
//   timesheet-kb.json 工作内容知识库（字符串数组，由 kbStore.js 维护）
// 读取按文件 mtime 缓存（与 WXP AISkillController.GetTimesheetFileConfig 同策略），
// 改配置文件即时生效，无需重启后端。目录可用 env TIMESHEET_CONFIG_DIR 覆盖（测试用）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const timesheetConfigDir =
  process.env.TIMESHEET_CONFIG_DIR || path.join(__dirname, '..', '..', 'Configs');

const cache = new Map(); // file -> { stamp, data }

function stampOf(p) {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/** 读取 JSON 文件（mtime 缓存）；缺失/损坏返回 fallback */
function readJson(name, fallback) {
  const p = path.join(timesheetConfigDir, name);
  const stamp = stampOf(p);
  if (stamp === null) return fallback;
  const hit = cache.get(name);
  if (hit && hit.stamp === stamp) return hit.data;
  let data = fallback;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    data = fallback; // 文件损坏按缺失处理，不让工时页 500
  }
  cache.set(name, { stamp, data });
  return data;
}

function writeJson(name, obj) {
  const dir = timesheetConfigDir;
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  // 写前备份到 Configs/backup/（对齐 WXP 行为，防手滑改坏）
  try {
    if (fs.existsSync(p)) {
      const bakDir = path.join(dir, 'backup');
      fs.mkdirSync(bakDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      fs.copyFileSync(p, path.join(bakDir, `${name.replace(/\.json$/, '')}-${ts}.json`));
    }
  } catch { /* 备份失败不阻断 */ }
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  cache.delete(name); // 立即失效缓存
}

// ---------- 工时主配置 ----------

export function getTimesheetFileConfig() {
  return readJson('timesheet.json', {});
}

/** 医院→在建项目绑定表（跳过 __TEMPLATE__ 模板节点） */
export function getHospitalConfigsDict() {
  const raw = getTimesheetFileConfig().HospitalConfigs || {};
  const out = {};
  for (const [code, cfg] of Object.entries(raw)) {
    if (code === '__TEMPLATE__' || !cfg || typeof cfg !== 'object') continue;
    out[code] = {
      hospitalName: cfg.hospitalName || '',
      inProjectId: Number(cfg.inProjectId) || 0,
      inProjectName: cfg.inProjectName || '',
      draftViewId: cfg.draftViewId || '',
    };
  }
  return out;
}

export function getHospitalConfig(hospitalId) {
  if (!hospitalId) return null;
  return getHospitalConfigsDict()[String(hospitalId)] || null;
}

/** 把医院→在建项目选择写回 Configs/timesheet.json */
export function saveHospitalProject({ hospitalCode, hospitalName, inProjectId, inProjectName }) {
  const obj = readJson('timesheet.json', {});
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('timesheet.json 不是 JSON 对象');
  if (!obj.HospitalConfigs || typeof obj.HospitalConfigs !== 'object') obj.HospitalConfigs = {};
  const one = obj.HospitalConfigs[hospitalCode] && typeof obj.HospitalConfigs[hospitalCode] === 'object'
    ? obj.HospitalConfigs[hospitalCode] : {};
  one.inProjectId = inProjectId;
  if (inProjectName) one.inProjectName = inProjectName;
  if (hospitalName && !one.hospitalName) one.hospitalName = hospitalName;
  obj.HospitalConfigs[hospitalCode] = one;
  writeJson('timesheet.json', obj);
}

// ---------- WXP / MCP 凭据 ----------

export function getWxpSettings() {
  const w = readJson('wxp.json', {}) || {};
  const s = w.WxpSettings || {};
  const api = s.Api || {};
  return {
    baseUrl: (s.BaseUrl || 'https://draft.winning.com.cn/backend').replace(/\/+$/, ''),
    userCode: s.UserCode || '',
    password: s.PasswordEncrypted || '',
    pmisLoginPath: api.PmisLogin || '/wxp/training/web/pmisLogin',
    queryMyCustomerListPath: api.QueryMyCustomerList || '/wxp/draft/issue/sheet/queryMyCustomerList',
    draftListPath: api.DraftList || '/wxp/draft/issue/sheet/normal',
  };
}

export function hasConfigAccount() {
  const s = getWxpSettings();
  return Boolean(s.userCode && s.password);
}

/** PMIS-MCP：{ url, authorization }（Authorization 已含 Bearer 前缀；env PMIS_MCP_TOKEN 可覆盖） */
export function getMcpServer() {
  const envUrl = process.env.PMIS_MCP_URL;
  const envToken = process.env.PMIS_MCP_TOKEN;
  const m = readJson('mcp.json', {}) || {};
  const srv = (m.McpServers || {})['PMIS-MCP'] || {};
  const headers = srv.Headers || {};
  let authorization = headers.Authorization || '';
  if (envToken) {
    authorization = envToken.startsWith('Bearer ') ? envToken : `Bearer ${envToken}`;
  }
  return {
    url: envUrl || srv.Url || 'https://weberp.winning.com.cn/mcp-http/mcp',
    authorization,
    headers: authorization ? { Authorization: authorization } : {},
  };
}

/** 更新 PMIS-MCP token（v1.18.46）：写回 mcp.json（自动备份+缓存失效，改完即时生效）。
 *  兼容粘贴带/不带 Bearer 前缀；返回归一后的纯 token。env PMIS_MCP_TOKEN 存在时调用方应拒绝修改。 */
export function updateMcpToken(rawToken) {
  let token = String(rawToken || '').trim();
  if (!token) throw new Error('token 不能为空');
  if (token.length > 500) throw new Error('token 过长（上限 500 字符）');
  token = token.replace(/^Bearer\s+/i, '');
  const m = readJson('mcp.json', {}) || {};
  m.McpServers = m.McpServers || {};
  const srv = { ...(m.McpServers['PMIS-MCP'] || {}) };
  srv.Headers = { ...(srv.Headers || {}), Authorization: `Bearer ${token}` };
  m.McpServers['PMIS-MCP'] = srv;
  writeJson('mcp.json', m);
  return token;
}
