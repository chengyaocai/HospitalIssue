// v1.18.16 端到端：处理人候选名单不再来自「系统设置」手工维护，改为实时派生自「当前机构的公司用户」。
//
// 规则钉住：
//   1) 平台管理员在某机构创建 company 用户 → 该机构 GET /api/config 的 handlers 包含
//      { empId: username, name }；hospital 用户不出现；
//   2) 机构隔离：company 用户只属机构 A → 机构 B 的 config.handlers 不含它；
//   3) 同一 company 用户属 A、B 两机构 → 两边都出现（各机构独立派生）；
//   4) PUT settings.handlers（手工名单）→ 200 但 config.handlers 仍为派生结果（存储仅留档）；
//   5) 未登录 GET /api/config 仍可用且带 handlers 数组（公开端点不破坏）；
//   6) 消费形状兼容：config.handlers 每项都有 name 与 empId 键（ProblemForm / DutyRoster 零改动）。
//
// 运行：cd backend && node test/handler-source.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3820 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `handlersrc-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `handlersrc-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'handler-source-test-secret',
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
const getConfig = async (token) => J(`${BASE}/api/config`, token);

async function main() {
  await waitReady();

  // ===== 0. 平台管理员登录（当前机构 = 默认机构 1）=====
  const admin = await login('admin', 'admin123');
  assert(admin.status === 200 && admin.body.user.platformAdmin === true, `平台管理员登录成功（HTTP ${admin.status}）`);
  const tk = admin.body.token;

  // ===== 1. hospital 用户不进处理人候选；company 用户进入 =====
  const mkHosp = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'hosp1', name: '院方张三', password: 'hosp12345', role: 'admin' }),
  });
  assert(mkHosp.status === 201 || mkHosp.status === 200, `新建院方用户 hosp1（HTTP ${mkHosp.status}）`);

  let cfg1 = (await getConfig(tk)).body;
  assert(Array.isArray(cfg1.handlers) && !cfg1.handlers.some((h) => h.name === '院方张三'),
    '机构无公司用户时派生为空数组，hospital 用户不出现');

  const mkVendor = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'vendor1', name: '厂商小王', password: 'vendor123', role: 'admin', userType: 'company' }),
  });
  assert((mkVendor.status === 201 || mkVendor.status === 200) && mkVendor.body.userType === 'company',
    `平台管理员创建公司用户 vendor1（HTTP ${mkVendor.status}）`);
  const vendorId = mkVendor.body.id;

  cfg1 = (await getConfig(tk)).body;
  const hit = (cfg1.handlers || []).find((h) => h.name === '厂商小王');
  assert(!!hit && hit.empId === 'vendor1' && hit.phone === '',
    `机构 1 config.handlers 包含公司用户 { empId:vendor1, name:厂商小王, phone:'' }（实测 ${JSON.stringify(hit)}）`);
  assert(!(cfg1.handlers || []).some((h) => h.name === '院方张三'), 'hospital 用户始终不进处理人候选');

  // ===== 2. 机构隔离：vendor1 只属机构 1 → 机构 2 的 config.handlers 不含它 =====
  const mkOrg2 = await J(`${BASE}/api/orgs`, tk, { method: 'POST', body: JSON.stringify({ code: 'zyy', name: '海盐县中医院' }) });
  assert(mkOrg2.status === 201 && mkOrg2.body.id, `新建机构 2 成功（id=${mkOrg2.body && mkOrg2.body.id}）`);
  const org2 = mkOrg2.body.id;
  const sw = await J(`${BASE}/api/auth/switch-org`, tk, { method: 'POST', body: JSON.stringify({ orgId: org2 }) });
  const tk2 = sw.body.token;
  assert(sw.status === 200 && !!tk2, `管理员切换到机构 2（HTTP ${sw.status}）`);

  const cfg2a = (await getConfig(tk2)).body;
  assert(Array.isArray(cfg2a.handlers) && !cfg2a.handlers.some((h) => h.name === '厂商小王'),
    '机构隔离：vendor1 未加入机构 2 时，机构 2 的 handlers 不含它');

  // ===== 3. 同一 company 用户属 A、B 两机构 → 两边都出现 =====
  const addOrg2 = await J(`${BASE}/api/users/${vendorId}/memberships`, tk, {
    method: 'POST', body: JSON.stringify({ orgId: org2, role: 'reporter' }),
  });
  assert(addOrg2.status === 200, `vendor1 加入机构 2（HTTP ${addOrg2.status}）`);
  const cfg2b = (await getConfig(tk2)).body;
  assert((cfg2b.handlers || []).some((h) => h.name === '厂商小王' && h.empId === 'vendor1'),
    'vendor1 加入机构 2 后，机构 2 的 handlers 也包含它（各机构独立派生）');
  const cfg1b = (await getConfig(tk)).body;
  assert((cfg1b.handlers || []).some((h) => h.name === '厂商小王' && h.empId === 'vendor1'),
    '机构 1 的 handlers 仍包含 vendor1（归属 A、B 两机构时两边都出现）');

  // ===== 4. PUT settings.handlers（手工名单）→ 200 但 config.handlers 仍为派生结果 =====
  const putManual = await J(`${BASE}/api/settings`, tk, {
    method: 'PUT', body: JSON.stringify({ handlers: [{ name: '手工名单' }] }),
  });
  assert(putManual.status === 200, `PUT settings.handlers 兼容接受（HTTP ${putManual.status}，200 而非 400）`);
  const cfgAfterPut = (await getConfig(tk)).body;
  assert(!(cfgAfterPut.handlers || []).some((h) => h.name === '手工名单') && (cfgAfterPut.handlers || []).some((h) => h.name === '厂商小王'),
    '手工名单写入后 config.handlers 不变（仍为机构公司用户派生结果，存储仅留档）');

  // ===== 5. 未登录 GET /api/config 仍可用且带 handlers 数组（公开端点不破坏）=====
  const anon = await getConfig(null);
  assert(anon.status === 200 && Array.isArray(anon.body.handlers),
    `未登录 GET /api/config 返回 200 且带 handlers 数组（HTTP ${anon.status}）`);
  assert((anon.body.handlers || []).some((h) => h.name === '厂商小王'),
    '未登录视角（默认机构）的 handlers 同样是公司用户派生结果');

  // ===== 6. 消费形状兼容：config.handlers 每项都有 name 与 empId 键 =====
  const allShapeOk = [cfg1b, cfg2b, anon.body].every((c) =>
    (c.handlers || []).every((h) => h && typeof h === 'object' && 'name' in h && 'empId' in h && 'phone' in h)
  );
  assert(allShapeOk, 'config.handlers 每项保持 { empId, name, phone } 结构（ProblemForm / DutyRoster 零改动可用）');
}

try {
  await main();
} catch (e) {
  failed++;
  console.error('  FAIL 套件异常：', (e && e.message) || e);
} finally {
  cleanup();
}

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
