// 冒烟测试：直接跑 release 包内的后端（dev 驱动，临时端口 3112）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REL = 'D:/AI/海盐县人民医院/信息科登记问题程序/release/hospital-issue-tracker-deploy';
const TMP = 'D:/AI/海盐县人民医院/信息科登记问题程序/.smoke-v12';
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
const BASE = 'http://127.0.0.1:3112/api';

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const server = spawn(NODE, ['src/index.js'], {
  cwd: path.join(REL, 'backend'),
  env: {
    ...process.env,
    PORT: '3112', DB_DRIVER: 'dev',
    DEV_DB_PATH: path.join(TMP, 'issues.json'),
    DEV_USERS_PATH: path.join(TMP, 'users.json'),
    AUDIT_DEV_PATH: path.join(TMP, 'audit.json'),
    SETTINGS_DEV_PATH: path.join(TMP, 'settings.json'),
    NOTIFICATIONS_DEV_PATH: path.join(TMP, 'notifications.json'),
    SCHEDULE_DEV_PATH: path.join(TMP, 'schedules.json'),
    UPLOADS_DIR: path.join(TMP, 'uploads'),
  },
  stdio: 'ignore',
});

let ok = false, cfgOk = false, loginOk = false, auditOk = false;
for (let i = 0; i < 60 && !ok; i++) {
  try { const r = await fetch(BASE + '/health'); ok = r.ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
}
if (ok) {
  const c = await (await fetch(BASE + '/config')).json();
  cfgOk = JSON.stringify(c).includes('issue.audit');
  // 从 release .env 读取首启管理员账号（dotenv 不覆盖已有环境变量，但我未注入 ADMIN_*）
  const envText = fs.readFileSync(path.join(REL, 'backend', '.env'), 'utf8').replace(/^\uFEFF/, '');
  const envMap = Object.fromEntries(envText.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
  }));
  const adminUser = envMap.ADMIN_USER || 'admin';
  const adminPass = envMap.ADMIN_PASSWORD || 'admin123';
  const l = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: adminUser, password: adminPass }) })).json();
  loginOk = !!l.token;
  const mk = await fetch(BASE + '/problems', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.token }, body: JSON.stringify({ title: '冒烟', department: '内科', reporter: '测试', type: '故障', severity: '低', status: '待处理', description: 'x' }) });
  const rec = await mk.json();
  const a = await fetch(BASE + `/problems/${rec.id}/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.token }, body: JSON.stringify({ result: 'approve' }) });
  auditOk = a.status === 200 && (await a.json()).audit_status === '已通过';
}
server.kill();
setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }, 400);
console.log(JSON.stringify({ health: ok, configHasAudit: cfgOk, login: loginOk, auditPass: auditOk }));
process.exit(ok && cfgOk && loginOk && auditOk ? 0 : 1);
