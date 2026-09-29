// v1.18.44 专项测试：用户管理「最近登录时间」列（app_user.last_login_at）。
//
// 规则钉住：
//   1) 登录成功即记录 lastLoginAt（花名册行内非空、且为最近时间）；
//   2) 从未登录的账号 lastLoginAt === null；
//   3) 新账号登录一次后 lastLoginAt 变为非空（登录事件驱动，不是认证请求驱动）；
//   4) 再次登录 lastLoginAt 不早于上次记录（单调更新）；
//   5) /users/lookup 形状不变：不含 lastLoginAt（不敏感接口零扩散）。
//
// 运行：cd backend && node test/last-login.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4120 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `lastlogin-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `lastlogin-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'last-login-test-secret',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin123', ADMIN_NAME: 'SystemAdmin',
    UPLOADS_DIR: uploads,
    ...files,
  },
  stdio: 'ignore',
});

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return; } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务未就绪');
}
function cleanup() {
  try { server.kill(); } catch { /* ignore */ }
  for (const f of Object.values(files)) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { fs.rmSync(uploads, { recursive: true, force: true }); } catch { /* ignore */ }
}
const J = async (url, token, opts = {}) => {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, body };
};
const login = async (username, password) => J(`${BASE}/api/auth/login`, null, {
  method: 'POST', body: JSON.stringify({ username, password }),
});
const fresh = (v) => {
  if (!v) return false;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && Date.now() - t < 5 * 60 * 1000;
};

async function main() {
  await waitReady();

  // ===== 1. admin 登录成功 → 花名册行内 lastLoginAt 非空且为最近 =====
  const first = await login('admin', 'admin123');
  assert(first.status === 200, `admin 首次登录成功（HTTP ${first.status}）`);
  const tk = first.body.token;

  const roster = await J(`${BASE}/api/users`, tk);
  const adminRow = (roster.body || []).find((u) => u.username === 'admin');
  assert(!!adminRow && fresh(adminRow.lastLoginAt),
    `登录后花名册 admin.lastLoginAt 非空且为最近（实测 ${adminRow && adminRow.lastLoginAt}）`);

  // ===== 2. 新建账号未登录 → lastLoginAt === null =====
  const mk = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'never1', name: '从未登录', password: 'never12345', role: 'reporter' }),
  });
  assert(mk.status === 201 || mk.status === 200, `新建账号 never1（HTTP ${mk.status}）`);
  const roster2 = await J(`${BASE}/api/users`, tk);
  const neverRow = (roster2.body || []).find((u) => u.username === 'never1');
  assert(!!neverRow && neverRow.lastLoginAt === null,
    `从未登录的账号 lastLoginAt === null（实测 ${neverRow && JSON.stringify(neverRow.lastLoginAt)}）`);

  // ===== 3. never1 登录一次 → lastLoginAt 变为非空 =====
  const nl = await login('never1', 'never12345');
  assert(nl.status === 200, `never1 登录成功（HTTP ${nl.status}）`);
  const roster3 = await J(`${BASE}/api/users`, tk);
  const neverRow2 = (roster3.body || []).find((u) => u.username === 'never1');
  assert(!!neverRow2 && fresh(neverRow2.lastLoginAt),
    `登录一次后 lastLoginAt 非空且为最近（实测 ${neverRow2 && neverRow2.lastLoginAt}）`);

  // ===== 4. 再次登录 → 单调更新（不早于上次记录）=====
  const prev = neverRow2.lastLoginAt;
  await new Promise((r) => setTimeout(r, 1100)); // 保证时间戳可比
  await login('never1', 'never12345');
  const roster4 = await J(`${BASE}/api/users`, tk);
  const neverRow3 = (roster4.body || []).find((u) => u.username === 'never1');
  assert(!!neverRow3 && new Date(neverRow3.lastLoginAt).getTime() >= new Date(prev).getTime(),
    `再次登录后 lastLoginAt 单调更新（${prev} → ${neverRow3 && neverRow3.lastLoginAt}）`);

  // ===== 5. /users/lookup 形状不变：不含 lastLoginAt =====
  const lk = await J(`${BASE}/api/users/lookup`, tk);
  const hasField = (lk.body || []).some((x) => Object.prototype.hasOwnProperty.call(x, 'lastLoginAt'));
  assert(lk.status === 200 && !hasField, 'lookup 元素不含 lastLoginAt（不敏感接口零扩散）');

  // ===== 6. 密码错误不记录：构造失败登录后 lastLoginAt 保持不变 =====
  const before = neverRow3.lastLoginAt;
  await new Promise((r) => setTimeout(r, 1100));
  const bad = await login('never1', 'wrong-password');
  assert(bad.status === 401, `错误密码登录被拒（HTTP ${bad.status}）`);
  const roster5 = await J(`${BASE}/api/users`, tk);
  const neverRow4 = (roster5.body || []).find((u) => u.username === 'never1');
  assert(neverRow4.lastLoginAt === before, `失败登录不更新 lastLoginAt（保持 ${before}）`);
}

try {
  await main();
} finally {
  cleanup();
}
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
