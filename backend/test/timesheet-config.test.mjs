// v1.18.43 专项测试：工时配置（前端可配置 + 按用户隔离）。
//
// 方案：本地 mock WXP（pmisLogin 记录每次登录的工号/密码 + 医院/底稿接口）与 mock PMIS-MCP
//（get_user_token + call_api 115），TIMESHEET_CONFIG_DIR 指向临时全局 Configs（系统默认账号 11547），
// 起后端（dev 驱动）后验证：
//   1) 初始 my-config：hasOwn=false、usingGlobalAccount=true、密码字段永不回显；
//   2) PUT my-config 保存个人凭据/默认值/绑定 → GET 回读（hasOwn=true、hasPassword=true、无密码明文）；
//   3) 个人凭据生效：/hospitals 用个人工号 88888 登录（mock 记录）、/unfilled 的 fill_user=88888；
//   4) 个人默认值与绑定生效：/config defaultWorkHours=6、13738 绑定个人值；未配置的医院回落全局；
//   5) 密码留空保存 = 保留原密码（/my-config/test 用已存密码登录成功）；
//   6) 测试连接：错误密码明确失败；
//   7) 用户隔离：第二个账号 hasOwn=false、不受第一个账号配置影响；
//   8) 登记页「记住绑定」（/save-project）写入个人配置；
//   9) 审计 UPDATE_TS_CONFIG；10) 权限模型（MENUS/登记员模板/迁移 v4）。
//
// 运行：cd backend && node test/timesheet-config.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stamp = Date.now();
const PORT = 3980 + (process.pid % 100);
const MCP_PORT = PORT + 1;
const WXP_PORT = PORT + 2;
const BASE = `http://localhost:${PORT}`;
const MCP = `http://localhost:${MCP_PORT}`;
const WXP = `http://localhost:${WXP_PORT}`;

const loginBodies = []; // mock WXP 记录的每次 pmisLogin {userCode, password}
const unfilledQps = []; // mock MCP 记录的 115 query_params

function readBody(req, cb) { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => cb(b)); }
function csvOf(rows) { return '\uFEFF' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n'; }

const wxpServer = http.createServer((req, res) => {
  readBody(req, (raw) => {
    const u = new URL(req.url, WXP);
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    if (u.pathname === '/wxp/training/web/pmisLogin') {
      loginBodies.push({ userCode: body?.userCode, password: body?.password });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (body?.password === 'wrong-pwd') {
        return res.end(JSON.stringify({ code: 40000, message: '工号或密码错误' }));
      }
      return res.end(JSON.stringify({ code: 20000, message: 'ok', data: { accessToken: 'pmis-tok', userCode: body?.userCode, userNote: `工号${body?.userCode}`, refreshToken: 'r', expiresIn: 7200 } }));
    }
    if (u.pathname === '/wxp/draft/issue/sheet/queryMyCustomerList') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 20000, message: 'ok', data: [
        { hospitalCode: '13738', hospitalName: '海盐县人民医院', province: '浙江', city: '嘉兴' },
        { hospitalCode: '99999', hospitalName: '全局兜底医院', province: '浙江', city: '嘉兴' },
      ] }));
    }
    if (u.pathname === '/wxp/draft/issue/sheet/normal') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 20000, message: 'ok', data: [
        { implementManager: '88888', statusName: '已关闭', closeTime: '2026-09-29 15:00:00', title: '个人账号的底稿' },
        { implementManager: '11547', statusName: '已关闭', closeTime: '2026-09-29 10:00:00', title: '默认账号的底稿' },
      ] }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 40000, message: 'mock 未知路径' }));
  });
});

const mcpServer = http.createServer((req, res) => {
  if (/^\/csv\//.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    return res.end(csvOf([['日期', '工时'], ['2026-09-29', '0']]));
  }
  readBody(req, (raw) => {
    const call = JSON.parse(raw);
    const tool = call.params?.name;
    const args = call.params?.arguments || {};
    if (tool === 'get_user_token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: JSON.stringify({ token: 'pmis-tok', userId: 888, username: '测试工号' }) }] } }));
    }
    if (tool === 'call_api' && args.api_id === '115') {
      unfilledQps.push(JSON.parse(JSON.parse(args.body).query_params || '{}'));
      const text = `${JSON.stringify({ status: 'ok', files: [{ download_url: `${MCP}/csv/115.csv` }] })}\n\n说明`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text }] } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? 0, error: { code: -32601, message: 'unknown' } }));
  });
});

const cfgDir = path.join(os.tmpdir(), `tscfg-cfg-${stamp}`);
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'timesheet.json'), JSON.stringify({
  DefaultTimesheetType: 2, DefaultCostLineId: 2, DefaultProcessType: 62, DefaultWorkHours: 8,
  InProgressStatusList: ['实施处理中'],
  HospitalConfigs: {
    13738: { hospitalName: '海盐县人民医院', inProjectId: 154267, inProjectName: '全局绑定项目', draftViewId: '' },
    99999: { hospitalName: '全局兜底医院', inProjectId: 188888, inProjectName: '全局兜底项目', draftViewId: '' },
  },
}, null, 2));
fs.writeFileSync(path.join(cfgDir, 'wxp.json'), JSON.stringify({ WxpSettings: { BaseUrl: WXP, UserCode: '11547', PasswordEncrypted: 'globalpwd,', Api: { PmisLogin: '/wxp/training/web/pmisLogin', QueryMyCustomerList: '/wxp/draft/issue/sheet/queryMyCustomerList', DraftList: '/wxp/draft/issue/sheet/normal' } } }, null, 2));
fs.writeFileSync(path.join(cfgDir, 'mcp.json'), JSON.stringify({ McpServers: { 'PMIS-MCP': { Url: MCP, Headers: { Authorization: 'Bearer t' } } } }, null, 2));
fs.writeFileSync(path.join(cfgDir, 'timesheet-kb.json'), JSON.stringify(['共享知识条目'], null, 2));

const tmp = (n) => path.join(os.tmpdir(), `tscfg-${n}-${stamp}.json`);
const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
  TIMESHEET_USER_DEV_PATH: tmp('tsuser'),
};
const uploads = path.join(os.tmpdir(), `tscfg-uploads-${stamp}`);
const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'timesheet-config-test-secret',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin123', ADMIN_NAME: 'SystemAdmin',
    UPLOADS_DIR: uploads,
    TIMESHEET_CONFIG_DIR: cfgDir,
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
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return; } catch { /* 等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务未就绪');
}
function cleanup() {
  try { server.kill(); } catch { /* */ }
  try { wxpServer.close(); } catch { /* */ }
  try { mcpServer.close(); } catch { /* */ }
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(uploads, { recursive: true, force: true }); } catch { /* */ }
  for (const f of Object.values(files)) { try { fs.unlinkSync(f); } catch { /* */ } }
}

async function login(username, password) {
  const r = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })).json();
  return { Authorization: `Bearer ${r.token}` };
}
const api = (p, opts = {}, auth) => fetch(`${BASE}/api/timesheet${p}`, {
  ...opts,
  headers: { ...(auth || {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
});

async function main() {
  await new Promise((r) => wxpServer.listen(WXP_PORT, r));
  await new Promise((r) => mcpServer.listen(MCP_PORT, r));
  await waitReady();
  const admin = await login('admin', 'admin123');

  // 1) 初始：hasOwn=false、usingGlobalAccount=true、密码不回显
  const mc0 = await (await api('/my-config', {}, admin)).json();
  assert(mc0.success === true && mc0.hasOwn === false && mc0.usingGlobalAccount === true,
    `初始 my-config：hasOwn=false、usingGlobalAccount=true（实测 ${JSON.stringify({ o: mc0.hasOwn, g: mc0.usingGlobalAccount })}）`);
  const mc0raw = JSON.stringify(mc0);
  assert(!mc0raw.includes('globalpwd'), '初始 my-config 响应不含系统默认密码明文');

  // 2) 保存个人配置
  const put = await (await api('/my-config', {
    method: 'PUT',
    body: JSON.stringify({
      wxpUserCode: '88888', wxpPassword: 'per-pwd',
      defaults: { timesheetType: 2, costLineId: 2, processType: 62, workHours: 6 },
      bindings: { '13738': { hospitalName: '海盐县人民医院', inProjectId: 999001, inProjectName: '个人绑定项目' } },
    }),
  }, admin)).json();
  assert(put.success === true, `PUT my-config 保存成功（实测 ${put.message || ''}）`);

  // 3) 回读：hasOwn=true、usingGlobalAccount=false、hasPassword=true、无密码明文
  const mc1 = await (await api('/my-config', {}, admin)).json();
  assert(mc1.hasOwn === true && mc1.usingGlobalAccount === false && mc1.config.wxpUserCode === '88888' && mc1.config.hasPassword === true,
    `回读：hasOwn=true、usingGlobalAccount=false、工号 88888、hasPassword=true`);
  assert(!JSON.stringify(mc1).includes('per-pwd'), '回读响应不含个人密码明文（密码永不回显）');

  // 4) 个人凭据生效：/hospitals 用 88888/per-pwd 登录（mock 记录）
  const hd = await (await api('/hospitals', {}, admin)).json();
  assert(hd.success === true, `/hospitals 成功（实测 ${hd.message || hd.hospitals?.length + ' 家'}）`);
  const perLogin = loginBodies.find((l) => l.userCode === '88888');
  assert(perLogin && perLogin.password === 'per-pwd', 'WXP 登录使用个人凭据（工号 88888 + 个人密码）');

  // 5) /unfilled fill_user=个人工号
  await api('/unfilled?startDate=2026-09-01&endDate=2026-09-29', {}, admin);
  const lastQp = unfilledQps[unfilledQps.length - 1];
  assert(lastQp?.fill_user === '88888', `/unfilled 的 fill_user=个人工号 88888（实测 ${lastQp?.fill_user}）`);

  // 6) /config：个人默认值 + 个人绑定覆盖全局；未配置医院回落全局
  const cfg = await (await api('/config', {}, admin)).json();
  assert(cfg.defaultWorkHours === 6 && cfg.hasOwn === true && cfg.usingGlobalAccount === false,
    `/config 个人默认值生效（defaultWorkHours=6）且附 hasOwn/usingGlobalAccount`);
  const h13738 = cfg.hospitalConfigs.find((h) => h.hospitalId === '13738');
  const h99999 = cfg.hospitalConfigs.find((h) => h.hospitalId === '99999');
  assert(h13738?.inProjectId === 999001 && h13738?.inProjectName === '个人绑定项目',
    `/config 医院 13738 用个人绑定（999001 个人绑定项目，覆盖全局 154267）`);
  assert(h99999?.inProjectId === 188888, '未配置个人绑定的医院回落全局（99999 → 188888）');

  // 7) /drafts 个人账号：mock 底稿 implementManager=88888 → mineCount=1（个人账号过滤）
  const dd = await (await api('/drafts?hospitalId=13738&hospitalName=海盐县人民医院&workDate=2026-09-29', {}, admin)).json();
  assert(dd.success === true && dd.mineCount === 1 && /个人账号的底稿/.test(dd.workContent || ''),
    `/drafts 以个人工号 88888 过滤底稿（mineCount=1）`);

  // 8) 密码留空保存 = 保留原密码；测试连接用已存密码
  const put2 = await (await api('/my-config', {
    method: 'PUT',
    body: JSON.stringify({ wxpUserCode: '88888', wxpPassword: '', defaults: { workHours: 7 } }),
  }, admin)).json();
  assert(put2.success === true, '再次保存（密码留空）成功');
  const testConn = await (await api('/my-config/test', {
    method: 'POST',
    body: JSON.stringify({ wxpUserCode: '88888', wxpPassword: '' }),
  }, admin)).json();
  assert(testConn.success === true && /连接成功/.test(testConn.message || ''),
    `测试连接用已存密码登录成功（实测 ${testConn.message}）`);
  const perLogin2 = loginBodies.filter((l) => l.userCode === '88888').pop();
  assert(perLogin2?.password === 'per-pwd', '测试连接实际使用已存密码（未清空）');
  const testBad = await (await api('/my-config/test', {
    method: 'POST',
    body: JSON.stringify({ wxpUserCode: '88888', wxpPassword: 'wrong-pwd' }),
  }, admin)).json();
  assert(testBad.success === false, `错误密码测试连接明确失败（实测 ${testBad.message}）`);

  // 9) 用户隔离：第二个账号 hasOwn=false、看不到 admin 的配置；/hospitals 走全局账号
  await (await fetch(`${BASE}/api/users`, {
    method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'user2', name: '同事二', password: 'u223456', role: 'reporter' }),
  }));
  const u2 = await login('user2', 'u223456');
  const mc2 = await (await api('/my-config', {}, u2)).json();
  assert(mc2.hasOwn === false && mc2.usingGlobalAccount === true, '第二个账号 hasOwn=false（配置按用户隔离，不互相可见）');
  const hd2 = await (await api('/hospitals', {}, u2)).json();
  assert(hd2.success === true, '第二账号 /hospitals 正常（回落全局账号 11547）');
  const gLogin = loginBodies.filter((l) => l.userCode === '11547').length;
  assert(gLogin >= 1, `第二账号登录使用系统默认工号 11547（全局回落，实测登录 ${gLogin} 次）`);

  // 10) 登记页「记住绑定」写入个人配置
  const sp = await (await api('/save-project', {
    method: 'POST',
    body: JSON.stringify({ hospitalCode: '13738', hospitalName: '海盐县人民医院', inProjectId: 777777, inProjectName: '记住的项目' }),
  }, admin)).json();
  assert(sp.success === true && /我的工时配置/.test(sp.message || ''), `/save-project 写入个人配置（实测 ${sp.message}）`);
  const mc3 = await (await api('/my-config', {}, admin)).json();
  assert(mc3.config.bindings['13738']?.inProjectId === 777777, '记住绑定后个人配置 13738 → 777777');

  // 11) 审计 UPDATE_TS_CONFIG
  const auditRes = await (await fetch(`${BASE}/api/audit?action=UPDATE_TS_CONFIG&page=1&pageSize=5`, { headers: admin })).json();
  const auditRows = auditRes.items || auditRes.rows || [];
  assert(auditRows.length >= 1, `审计含「修改工时配置」动作（${auditRows.length} 条）`);

  // 12) 权限模型
  const permMod = await import('../src/permissions.js');
  assert(permMod.MENUS.some((m) => m.key === 'tsconfig' && m.label === '工时配置'), '后端 MENUS 含 tsconfig（工时配置）');
  assert(permMod.defaultRolePermissions('reporter').menus.includes('tsconfig'), '登记员默认模板含 tsconfig');
  const cfgApi = await (await fetch(`${BASE}/api/config`, { headers: admin })).json();
  assert(cfgApi.permissions?.admin?.menus?.includes('tsconfig'), '/api/config 的 admin 权限含 tsconfig（存量迁移 v4 生效）');
  assert(cfgApi.permissions?.reporter?.menus?.includes('tsconfig'), '/api/config 的 reporter 权限含 tsconfig（存量迁移 v4 生效）');
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
