// PMIS-MCP 客户端（v1.18.42 原生集成）：把 WXP AISkillController 的 MCP 链路移植为 Node 原生实现。
//   getAndRefreshPmisToken()  调 MCP tools/call get_user_token —— 兼做健康检查 + 取当前 PMIS 用户
//   callPmisApi(apiId, body)  调 MCP tools/call call_api —— 查询类返回 CSV 行字典，提交类返回原文
// CSV 链路：content[0].text 前段（到 \n\n 为止）是 JSON summary，取 files[].download_url 下载
// UTF-8 BOM CSV → 逗号切分成行字典；无 download_url（提交类）→ [{raw:text}]。
// 与 C# 版差异：不再回写 auth.json（本系统没有外部 AI agent 消费它）。
// v1.18.49：全链路支持 authOverride（个人 PMIS-MCP token，工时配置里按用户维护）——
//   个人 token 优先覆盖全局 mcp.json 的 Authorization；不传/空 = 行为与旧版完全一致。

import { getMcpServer } from './configs.js';

let mcpIdSeq = 0;

/** 归一个人 token 覆盖：空 = 不覆盖（用全局 mcp.json）；裸 token 自动补 Bearer 前缀 */
function normAuth(authOverride) {
  const t = String(authOverride ?? '').trim();
  if (!t) return null;
  return /^Bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

/** 请求头：authOverride 非空时覆盖全局 Authorization（个人 token 优先） */
function jsonHeaders(mcp, authOverride) {
  const base = { Accept: 'application/json', 'Content-Type': 'application/json', ...mcp.headers };
  const auth = normAuth(authOverride);
  return auth ? { ...base, Authorization: auth } : base;
}

async function postJson(url, body, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 调 MCP 工具；返回 { ok, result, errorText }（ok=false 时 errorText 给出可读原因） */
async function mcpCallTool(name, args, timeoutMs = 30000, authOverride = null) {
  const mcp = getMcpServer();
  if (!mcp.url) return { ok: false, errorText: 'PMIS-MCP 未配置（Configs/mcp.json 里需要 PMIS-MCP server）' };
  const callObj = {
    jsonrpc: '2.0',
    id: ++mcpIdSeq,
    method: 'tools/call',
    params: { name, arguments: args },
  };
  let resp;
  try {
    resp = await postJson(mcp.url, callObj, jsonHeaders(mcp, authOverride), timeoutMs);
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : String(err?.message || err);
    return { ok: false, errorText: `PMIS-MCP 连接失败：${reason}` };
  }
  if (!resp.ok) return { ok: false, errorText: `PMIS-MCP HTTP ${resp.status}` };
  // MCP 鉴权失败时可能返回中文错误文本/HTML，先确认是 JSON
  const body = (resp.text || '').trim();
  if (!body || (body[0] !== '{' && body[0] !== '[')) {
    const snippet = body.length > 80 ? `${body.slice(0, 80)}...` : body;
    return { ok: false, errorText: `PMIS-MCP 返回非 JSON（HTTP 200）：${snippet}`, authFailure: true };
  }
  let root;
  try {
    root = JSON.parse(body);
  } catch (err) {
    return { ok: false, errorText: `PMIS-MCP 响应解析失败：${err?.message || err}`, authFailure: true };
  }
  if (root.error) return { ok: false, errorText: `MCP error: ${JSON.stringify(root.error)}`, authFailure: true };
  const result = root.result;
  if (!result || !Array.isArray(result.content) || result.content.length === 0) {
    return { ok: false, errorText: 'MCP 返回无 content', authFailure: true };
  }
  if (result.isError === true) {
    const errText = typeof result.content[0]?.text === 'string' ? result.content[0].text : '';
    return { ok: false, errorText: `PMIS-MCP 调用失败：${errText}`, authFailure: true };
  }
  return { ok: true, result };
}

/**
 * 调 get_user_token：验证 MCP 连接有效并取当前 PMIS 用户。
 * authOverride：个人 token（工时配置里维护）——传入时取的是「该 token 对应的 PMIS 用户」。
 * 返回 { authExpired, errorMessage, userId, token, username }
 */
export async function getAndRefreshPmisToken(authOverride = null) {
  const r = await mcpCallTool('get_user_token', {}, 30000, authOverride);
  if (!r.ok) return { authExpired: true, errorMessage: r.errorText, userId: null };
  const text = typeof r.result.content[0]?.text === 'string' ? r.result.content[0].text : '';
  if (!text.trim() || (text.trim()[0] !== '{' && text.trim()[0] !== '[')) {
    const snippet = text.length > 120 ? `${text.slice(0, 120)}...` : text;
    return { authExpired: true, errorMessage: `PMIS-MCP 返回非 JSON text：${snippet}`, userId: null };
  }
  let ir;
  try {
    ir = JSON.parse(text);
  } catch (err) {
    return { authExpired: true, errorMessage: `get_user_token 响应解析失败：${err?.message || err}`, userId: null };
  }
  const token = typeof ir.token === 'string' ? ir.token : null;
  const userId = ir.userId != null ? String(ir.userId) : null;
  const username = typeof ir.username === 'string' ? ir.username : null;
  if (!token) return { authExpired: true, errorMessage: 'get_user_token 返回空 token', userId: null };
  return { authExpired: false, errorMessage: null, userId, token, username };
}

/** 取当前 PMIS 用户 ID（复用 get_user_token；个人 token 优先） */
export async function getPmisUserId(authOverride = null) {
  const r = await getAndRefreshPmisToken(authOverride);
  return r.authExpired ? null : r.userId;
}

function parseCsvRows(csvText) {
  const text = csvText.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const lines = text.split(/\r|\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((s) => s.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map((s) => s.trim());
    const row = {};
    for (let j = 0; j < headers.length && j < vals.length; j++) row[headers[j]] = vals[j];
    rows.push(row);
  }
  return rows;
}

async function doCallPmisApi(apiId, bodyObj, authOverride = null) {
  const mcp = getMcpServer();
  const args = { api_id: apiId, body: JSON.stringify(bodyObj) };
  const r = await mcpCallTool('call_api', args, 60000, authOverride);
  if (!r.ok) return { rows: [], error: r.errorText };

  const text = typeof r.result.content[0]?.text === 'string' ? r.result.content[0].text : '';
  // text 开头（到第一个空行 \n\n 为止）是 JSON summary，后面可能跟 markdown 说明
  const jsonEnd = text.indexOf('\n\n');
  const summaryJson = jsonEnd > 0 ? text.slice(0, jsonEnd) : text;

  let downloadUrl = null;
  try {
    const s = JSON.parse(summaryJson);
    if (Array.isArray(s.files)) {
      for (const f of s.files) {
        if (f && typeof f.download_url === 'string' && f.download_url) { downloadUrl = f.download_url; break; }
      }
    }
    if (s.status === 'error') return { rows: [], error: s.message || '未知错误' };
  } catch { /* summary 可能不是 JSON，忽略 */ }

  if (!downloadUrl) {
    // 提交类 API 没有 CSV，直接返回 content 原文作为结果
    return { rows: [{ raw: text }], error: null };
  }

  // 下载 CSV（带相同 Authorization；个人 token 优先覆盖全局）
  const dlHeaders = { Accept: '*/*', ...mcp.headers };
  const ovr = normAuth(authOverride);
  if (ovr) dlHeaders.Authorization = ovr;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let csvText;
  try {
    const dl = await fetch(downloadUrl, { headers: dlHeaders, signal: ctrl.signal });
    if (!dl.ok) return { rows: [], error: `CSV 下载失败: HTTP ${dl.status}` };
    csvText = await dl.text();
  } catch (err) {
    const reason = err?.name === 'AbortError' ? '请求超时（30s）' : String(err?.message || err);
    return { rows: [], error: `CSV 下载失败: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
  // 空 CSV / 只有表头：查询类接口（如 115 未填报）在"无数据"时的正常返回
  return { rows: parseCsvRows(csvText), error: null };
}

/**
 * 通过 MCP 调 PMIS API。先 get_user_token 健康检查（失败等 1s 重试一次），再 call_api。
 * authOverride：个人 token（工时配置里维护）——传入时整条链路走该 token 对应的 PMIS 账号。
 * 返回 { rows, error } —— error 非 null 时 rows 为空。
 */
export async function callPmisApi(apiId, bodyObj, authOverride = null) {
  let check = await getAndRefreshPmisToken(authOverride);
  if (check.authExpired) {
    await new Promise((r) => setTimeout(r, 1000)); // 等 1 秒让 MCP 服务端刷新
    check = await getAndRefreshPmisToken(authOverride);
  }
  if (check.authExpired) {
    return { rows: [], error: `PMIS-MCP 鉴权失败：${check.errorMessage || 'token 过期，PMIS 重新登录后再来'}` };
  }
  return doCallPmisApi(apiId, bodyObj, authOverride);
}
