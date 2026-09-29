// v1.18.41 专项测试：用户在线状态（内存 presence 表 + GET /api/users/presence）。
//
// 规则钉住：
//   1) 未登录 GET /api/users/presence → 401；
//   2) 登录后立即查询：online 含 admin 自己（认证请求即心跳）；
//   3) 从未活跃的账号不在 online 列表；
//   4) 纯函数：touch 后用超过窗口的 now 查询 → 不在线（90s 窗口判定）；窗口常量 = 90000ms；
//   5) 端点形态：{ online: [username...], windowMs }，windowMs === 90000。
//
// 运行：cd backend && node test/presence.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4020 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `presence-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `presence-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'presence-test-secret',
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

async function main() {
  await waitReady();

  // 4) 纯函数（不依赖 HTTP）：窗口判定
  const presence = await import('../src/presence.js');
  assert(presence.ONLINE_WINDOW_MS === 90000, 'ONLINE_WINDOW_MS = 90000（90s 窗口）');
  presence.touchPresence('alice');
  assert(presence.onlineUsernames().includes('alice'), 'touch 后 onlineUsernames 含该账号');
  assert(!presence.onlineUsernames(Date.now() + 90001).includes('alice'), '超过 90s 窗口后判定离线（过期清理）');

  // 1) 未登录 401
  const unauth = await fetch(`${BASE}/api/users/presence`);
  assert(unauth.status === 401, `未登录 GET /presence → 401（实测 ${unauth.status}）`);

  // 登录（登录请求本身就是一次心跳）
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const auth = { Authorization: `Bearer ${login.token}` };

  // 2) + 5) 立即查询：admin 在线、形态正确
  const d = await (await fetch(`${BASE}/api/users/presence`, { headers: auth })).json();
  assert(Array.isArray(d.online) && d.online.includes('admin'), '登录后立即查询：online 含 admin 自己（认证请求即心跳）');
  assert(d.windowMs === 90000, `端点形态 { online, windowMs=90000 }（实测 windowMs=${d.windowMs}）`);

  // 3) 建一个新用户且该用户从不发请求 → 不在 online
  await fetch(`${BASE}/api/users`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'idle1', name: '从不在线', password: 'idle12345', role: 'reporter' }),
  });
  const d2 = await (await fetch(`${BASE}/api/users/presence`, { headers: auth })).json();
  assert(!d2.online.includes('idle1'), '从未活跃的账号不在 online 列表');
}

try {
  await main();
} catch (e) {
  failed++;
  console.error('  FAIL 测试执行异常：', e);
} finally {
  cleanup();
}
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
