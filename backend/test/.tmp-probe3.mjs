// 一次性探针3（跑完即删）：真实 server 登录取真 JWT，再用真实中间件链逐层打点
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.JWT_SECRET = 'probe-secret'; // 必须在动态 import config 前设置
const { default: express } = await import('express');
const { authenticate } = await import('../src/auth/middleware.js');
const { requirePlatformAdmin } = await import('../src/auth/authorize.js');
const { getMcpServer } = await import('../src/timesheet/configs.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.JWT_SECRET = 'probe-secret'; // 必须在 import config 前设置（config.js import 时读取）
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `tsp3-${stamp}-${n}.json`);
const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
  TIMESHEET_USER_DEV_PATH: tmp('tsuser'),
};
const cfgDir = path.join(os.tmpdir(), `tsp3-cfg-${stamp}`);
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'mcp.json'), JSON.stringify({ McpServers: { 'PMIS-MCP': { Url: 'http://127.0.0.1:9/mcp', Headers: { Authorization: 'Bearer probe-token-1234-wxyz' } } } }));
fs.writeFileSync(path.join(cfgDir, 'wxp.json'), '{}');
fs.writeFileSync(path.join(cfgDir, 'timesheet.json'), '{}');

const real = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, DB_DRIVER: 'dev', PORT: '4596', JWT_SECRET: 'probe-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin123', ...files, TIMESHEET_CONFIG_DIR: cfgDir },
  stdio: 'ignore',
});
for (let i = 0; i < 100; i++) {
  try { const r = await fetch('http://localhost:4596/api/config'); if (r.ok) break; } catch { /* wait */ }
  await new Promise((r) => setTimeout(r, 150));
}
const lg = await fetch('http://localhost:4596/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
const token = (await lg.json()).token;
console.log('[probe] got real token, length', token.length);
real.kill();

// 最小 app：真实中间件逐层打点
const app = express();
app.use(express.json());
const tag = (name) => (req, res, next) => { console.log(`[layer] enter ${name}`); next(); };
app.get('/t1', tag('auth'), authenticate, tag('rpa'), requirePlatformAdmin(), tag('handler'), (req, res) => {
  console.log('[layer] handler body start');
  const m = getMcpServer();
  console.log('[layer] getMcpServer done:', m.url, m.authorization.slice(0, 20));
  res.json({ ok: true });
});
const srv = app.listen(4595, async () => {
  await new Promise((r) => setTimeout(r, 200));
  try {
    const r = await fetch('http://localhost:4595/t1', { signal: AbortSignal.timeout(6000), headers: { Authorization: `Bearer ${token}` } });
    console.log('[probe] /t1 ->', r.status, await r.text());
  } catch (e) { console.log('[probe] /t1 ERR', e.message); }
  process.exit(0);
});
