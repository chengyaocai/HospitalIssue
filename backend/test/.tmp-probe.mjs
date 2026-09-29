// 一次性探针（跑完即删）：定位 reporter1 登录 / server-config 403 环节的挂起
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `tsprobe-${stamp}-${n}.json`);
const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
  TIMESHEET_USER_DEV_PATH: tmp('tsuser'),
};
const cfgDir = path.join(os.tmpdir(), `tsprobe-cfg-${stamp}`);
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'mcp.json'), '{}');
fs.writeFileSync(path.join(cfgDir, 'wxp.json'), '{}');
fs.writeFileSync(path.join(cfgDir, 'timesheet.json'), '{}');
const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env, DB_DRIVER: 'dev', PORT: '4599',
    JWT_SECRET: 'probe', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin123',
    ...files, TIMESHEET_CONFIG_DIR: cfgDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => console.log('[srv-out]', String(d).trim()));
server.stderr.on('data', (d) => console.log('[srv-err]', String(d).trim()));

const BASE = 'http://localhost:4599';
const J = async (url, token, opts = {}) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    const body = await r.json().catch(() => null);
    console.log(`[${Date.now() - t0}ms]`, opts.method || 'GET', url.replace(BASE, ''), '->', r.status, JSON.stringify(body).slice(0, 120));
    return { status: r.status, body };
  } catch (e) {
    console.log(`[${Date.now() - t0}ms]`, opts.method || 'GET', url.replace(BASE, ''), '-> ERR', e.message);
    return { status: 0, body: null };
  }
};
for (let i = 0; i < 100; i++) {
  try { const r = await fetch(`${BASE}/api/config`); if (r.ok) break; } catch { /* wait */ }
  await new Promise((r) => setTimeout(r, 150));
}
console.log('--- ready ---');
const lg = await J(`${BASE}/api/auth/login`, null, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
const tk = lg.body.token;
const mk = await J(`${BASE}/api/users`, tk, { method: 'POST', body: JSON.stringify({ username: 'rep1', name: '普1', password: 'rep12345678', role: 'reporter' }) });
console.log('--- created, now login reporter ---');
const rlg = await J(`${BASE}/api/auth/login`, null, { method: 'POST', body: JSON.stringify({ username: 'rep1', password: 'rep12345678' }) });
console.log('--- now probe timesheet endpoints one by one ---');
await J(`${BASE}/api/timesheet/kb`, tk);
await J(`${BASE}/api/timesheet/config`, tk);
await J(`${BASE}/api/timesheet/my-config`, tk);
await J(`${BASE}/api/timesheet/server-config`, tk);
console.log('--- reporter server-config ---');
await J(`${BASE}/api/timesheet/server-config`, rlg.body?.token);
console.log('--- done ---');
server.kill();
process.exit(0);
