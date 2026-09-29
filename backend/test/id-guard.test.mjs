// v1.18.26 专项测试：/problems/:id 路由的 id 参数防御（parseIdParam）。
// 背景：生产 mssql 部署旧版 problems.js（缺 export-draft 路由）时，
// GET /api/problems/export-draft 落到 /problems/:id，非数字字符串被直接
// 绑进 mssql BigInt 参数打出 500 堆栈。修复后非法 id 一律 404「问题不存在」。
// 运行：node test/id-guard.test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3319;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmpDb = path.join(os.tmpdir(), `issues-idguard-${stamp}.json`);
const tmpUsers = path.join(os.tmpdir(), `users-idguard-${stamp}.json`);
const tmpAudit = path.join(os.tmpdir(), `audit-idguard-${stamp}.json`);
const tmpUploads = path.join(os.tmpdir(), `uploads-idguard-${stamp}`);
const tmpSettings = path.join(os.tmpdir(), `settings-idguard-${stamp}.json`);
const tmpNotifications = path.join(os.tmpdir(), `notifications-idguard-${stamp}.json`);
const tmpChat = path.join(os.tmpdir(), `chat-idguard-${stamp}.json`);
const tmpOrgs = path.join(os.tmpdir(), `orgs-idguard-${stamp}.json`);
const tmpSchedules = path.join(os.tmpdir(), `schedules-idguard-${stamp}.json`);

const env = {
  ...process.env,
  DB_DRIVER: 'dev',
  DEV_DB_PATH: tmpDb,
  DEV_USERS_PATH: tmpUsers,
  AUDIT_DEV_PATH: tmpAudit,
  UPLOADS_DIR: tmpUploads,
  SETTINGS_DEV_PATH: tmpSettings,
  NOTIFICATIONS_DEV_PATH: tmpNotifications,
  CHAT_DEV_PATH: tmpChat,
  ORGS_DEV_PATH: tmpOrgs,
  SCHEDULE_DEV_PATH: tmpSchedules,
  PORT: String(PORT),
};
const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env, stdio: 'inherit' });

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

async function waitReady() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready');
}

let TOKEN = '';
async function authFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}), Authorization: 'Bearer ' + TOKEN };
  return fetch(BASE + url, { ...opts, headers });
}

function cleanup() {
  server.kill();
  for (const f of [tmpDb, tmpUsers, tmpAudit, tmpSettings, tmpNotifications, tmpChat, tmpOrgs, tmpSchedules]) { try { fs.unlinkSync(f); } catch {} }
  try { fs.rmSync(tmpUploads, { recursive: true, force: true }); } catch {}
}

async function main() {
  await waitReady();

  // admin 登录（具备全部权限：确保后续 404 来自 id 防御而非权限拦截）
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  TOKEN = login.token;
  assert(!!TOKEN, 'admin 登录拿到 token');

  // ---- 1) 非法 id：统一 404「问题不存在」，绝不 500 / NaN 查询 ----
  const badIds = ['abc', '12abc', '-1', '1e3', '0', '1.5', '99999999999999999999'];
  for (const bad of badIds) {
    const r = await authFetch(`/api/problems/${bad}`);
    const body = await r.json().catch(() => ({}));
    assert(r.status === 404 && body.error === '问题不存在',
      `GET /api/problems/${bad} -> 404 问题不存在（实际 ${r.status} ${JSON.stringify(body.error || '')}）`);
  }

  // 旧部署事故路径：/problems/export-draft 落到 :id 的场景必须被 404 兜底
  // （当前代码有该路由，这里验证 :id 守卫本身；导出功能由 draft-export 套件覆盖）
  const rd = await authFetch('/api/problems/export-draftx');
  assert(rd.status === 404 && (await rd.json()).error === '问题不存在', "GET /api/problems/export-draftx -> 404 问题不存在");

  // ---- 2) 各 :id 动作路由同样被守卫（用有权限的 admin，404 必来自 id 解析）----
  assert((await authFetch('/api/problems/abc', { method: 'PUT', body: JSON.stringify({ title: 'x' }) })).status === 404,
    "PUT /api/problems/abc -> 404");
  assert((await authFetch('/api/problems/abc', { method: 'DELETE' })).status === 404,
    "DELETE /api/problems/abc -> 404");
  assert((await authFetch('/api/problems/abc/audit', { method: 'POST', body: JSON.stringify({ result: 'approve' }) })).status === 404,
    "POST /api/problems/abc/audit -> 404");
  assert((await authFetch('/api/problems/abc/satisfaction', { method: 'POST', body: JSON.stringify({ satisfaction: '满意' }) })).status === 404,
    "POST /api/problems/abc/satisfaction -> 404");
  assert((await authFetch('/api/problems/abc/restore', { method: 'POST' })).status === 404,
    "POST /api/problems/abc/restore -> 404");
  assert((await authFetch('/api/problems/abc/hard', { method: 'DELETE' })).status === 404,
    "DELETE /api/problems/abc/hard -> 404");

  // ---- 3) 合法数字 id：行为完全不变（创建 → 详情 → 导出 → 回收站）----
  const created = await (await authFetch('/api/problems', {
    method: 'POST',
    body: JSON.stringify({
      title: 'id 守卫回归样例', department: '信息科', reporter: '测试甲',
      type: '故障', severity: '低', description: '验证合法 id 路径不受影响',
    }),
  })).json();
  assert(created && Number.isInteger(created.id) && created.id > 0, '合法创建问题返回数字 id');

  const got = await (await authFetch(`/api/problems/${created.id}`)).json();
  assert(got && got.id === created.id && got.title === 'id 守卫回归样例', `GET /api/problems/${created.id} 正常返回详情`);

  const putRes = await authFetch(`/api/problems/${created.id}`, { method: 'PUT', body: JSON.stringify({ status: '已解决' }) });
  assert(putRes.status === 200 && (await putRes.json()).status === '已解决', `PUT /api/problems/${created.id} 正常更新`);

  // 审核通过后 export-draft 正常出 XLSX（不再落 :id、不再 500）
  const auditRes = await authFetch(`/api/problems/${created.id}/audit`, { method: 'POST', body: JSON.stringify({ result: 'approve' }) });
  assert(auditRes.status === 200, `POST /api/problems/${created.id}/audit 正常通过`);
  const exp = await authFetch('/api/problems/export-draft');
  assert(exp.status === 200 && (exp.headers.get('content-type') || '').includes('spreadsheetml'),
    'GET /api/problems/export-draft 正常返回 XLSX');

  const delRes = await authFetch(`/api/problems/${created.id}`, { method: 'DELETE' });
  const restored = await authFetch(`/api/problems/${created.id}/restore`, { method: 'POST' });
  const purged = await authFetch(`/api/problems/${created.id}/hard`, { method: 'DELETE' });
  assert(delRes.status === 200 && restored.status === 200 && purged.status === 200,
    `DELETE/restore/hard 对合法 id 依次正常（${delRes.status}/${restored.status}/${purged.status}）`);

  console.log(`\nid-guard: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(cleanup);
