// v1.18.46 专项测试：工时配置「绑定按登录用户自动获取 + PMIS-MCP Token 界面化维护」。
//
// 规则钉住：
//   1) GET /timesheet/hospitals —— 绑定表按登录用户动态拉取本人 WXP 客户医院；
//      绑定生效优先级 source=own > auto（按医院名检索本人 PMIS 在建项目，
//      项目名/客户名包含医院名即命中）> sys（Configs 固定绑定兜底）> none；
//      inProjectId/inProjectName 恒为「当前生效值」。
//   2) GET/PUT /timesheet/server-config —— 仅平台管理员（非管理员 403）；
//      GET 只给掩码（前6…后4）不回显明文，fromEnv 标注 env 覆盖；
//      PUT 校验空/超长/env 覆盖拒绝，写回 mcp.json（保留 Url、Bearer 归一、自动备份）；
//      审计 UPDATE_TS_TOKEN 只记长度不落明文；更新后 MCP 侧立即用新 token（即时生效，无需重启）。
//
// 运行：cd backend && node test/timesheet-auto.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

// ---------- 本地 mock：MCP（JSON-RPC tools/call） ----------
const ORIG_TOKEN = 'orig-token-aaaa1111bbbb-zzzz';
let lastMcpAuth = ''; // 记录 MCP mock 收到的最新 Authorization（验证「即时生效」）

function startMcpMock() {
  const csvText = [
    '在建项目ID,在建项目名称,客户名称,项目经理,项目类型,执行状态',
    '1001,海盐县人民医院信息科项目,海盐县人民医院,张三,实施,执行',
    '1002,中医联动项目,海盐县中医院,李四,实施,执行',
  ].join('\r\n');
  const srv = http.createServer((rq, rs) => {
    lastMcpAuth = String(rq.headers.authorization || '');
    if (rq.method === 'GET' && rq.url === '/csv65') {
      rs.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      rs.end(csvText);
      return;
    }
    let raw = '';
    rq.on('data', (c) => { raw += c; });
    rq.on('end', () => {
      let req = null;
      try { req = JSON.parse(raw); } catch { /* ignore */ }
      const name = req?.params?.name;
      let text = '';
      if (name === 'get_user_token') {
        text = JSON.stringify({ token: 'pmis-t', userId: '9', username: 'tester' });
      } else if (name === 'call_api') {
        const summary = { status: 'ok', files: [{ download_url: `http://127.0.0.1:${mcpPort}/csv65` }] };
        text = `${JSON.stringify(summary)}\n\n（CSV 已生成）`;
      } else {
        text = JSON.stringify({ token: 'pmis-t', userId: '9' });
      }
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ jsonrpc: '2.0', id: req?.id ?? 0, result: { content: [{ type: 'text', text }] } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

// ---------- 本地 mock：WXP（pmisLogin + queryMyCustomerList） ----------
const HOSPITALS = [
  { hospitalCode: 'H001', hospitalName: '海盐县人民医院', province: '浙江省', city: '嘉兴市' },
  { hospitalCode: 'H002', hospitalName: '海盐县中医院', province: '浙江省', city: '嘉兴市' },
  { hospitalCode: 'H003', hospitalName: '海盐县妇幼保健院', province: '浙江省', city: '嘉兴市' },
  { hospitalCode: 'H004', hospitalName: '测试诊所', province: '浙江省', city: '嘉兴市' },
];
function startWxpMock() {
  const srv = http.createServer((rq, rs) => {
    let raw = '';
    rq.on('data', (c) => { raw += c; });
    rq.on('end', () => {
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      if (rq.url === '/wxp/training/web/pmisLogin') {
        let uc = 'sysuser';
        try { uc = JSON.parse(raw).userCode || uc; } catch { /* ignore */ }
        rs.end(JSON.stringify({
          code: 20000, message: 'ok',
          data: { accessToken: 'wxptoken', userCode: uc, userNote: `用户${uc}`, expiresIn: 7200, refreshToken: 'r' },
        }));
        return;
      }
      if (rq.url === '/wxp/draft/issue/sheet/queryMyCustomerList') {
        rs.end(JSON.stringify({ code: 20000, message: 'ok', data: HOSPITALS }));
        return;
      }
      rs.end(JSON.stringify({ code: 20000, message: 'ok', data: [] }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

const stamp = Date.now();
const tmpbase = path.join(os.tmpdir(), `tsauto-${stamp}`);
fs.mkdirSync(tmpbase, { recursive: true });
const cfgDir = path.join(tmpbase, 'Configs');
fs.mkdirSync(cfgDir, { recursive: true });

const { srv: mcpSrv, port: mcpPort } = await startMcpMock();
const { srv: wxpSrv, port: wxpPort } = await startWxpMock();

// Configs 临时目录：mcp.json（原始 token）/ wxp.json（系统默认账号）/ timesheet.json（H003 sys 绑定）
fs.writeFileSync(path.join(cfgDir, 'mcp.json'), JSON.stringify({
  McpServers: { 'PMIS-MCP': { Url: `http://127.0.0.1:${mcpPort}/mcp`, Headers: { Authorization: `Bearer ${ORIG_TOKEN}` } } },
}, null, 2));
fs.writeFileSync(path.join(cfgDir, 'wxp.json'), JSON.stringify({
  WxpSettings: { BaseUrl: `http://127.0.0.1:${wxpPort}`, UserCode: 'sysuser', PasswordEncrypted: 'syspass', Api: {} },
}, null, 2));
fs.writeFileSync(path.join(cfgDir, 'timesheet.json'), JSON.stringify({
  InProgressStatusList: [], TimesheetTypes: [], CostLineOptions: [], ProcessTypeOptions: [],
  DefaultTimesheetType: 2, DefaultCostLineId: 2, DefaultProcessType: 62, DefaultWorkHours: 8,
  HospitalConfigs: {
    H003: { hospitalName: '海盐县妇幼保健院', inProjectId: 3003, inProjectName: '妇幼老项目' },
    H004: { hospitalName: '测试诊所', inProjectId: 0, inProjectName: '' },
  },
}, null, 2));

function devFiles(tag) {
  const t = (n) => path.join(tmpbase, `${tag}-${n}.json`);
  return {
    DEV_DB_PATH: t('issues'), DEV_USERS_PATH: t('users'), AUDIT_DEV_PATH: t('audit'),
    SETTINGS_DEV_PATH: t('settings'), NOTIFICATIONS_DEV_PATH: t('notif'),
    CHAT_DEV_PATH: t('chat'), ORGS_DEV_PATH: t('orgs'), SCHEDULE_DEV_PATH: t('sched'),
    // 工时个人配置（v1.18.43）dev 落 data/timesheet-user.json，必须同样隔离（否则会污染真实 dev 数据）
    TIMESHEET_USER_DEV_PATH: t('tsuser'),
  };
}
const uploads = path.join(tmpbase, 'uploads');
const PORT = 4150 + (process.pid % 200);
const PORT2 = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const BASE2 = `http://localhost:${PORT2}`;

function spawnServer(port, extraEnv = {}) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env, DB_DRIVER: 'dev', PORT: String(port),
      JWT_SECRET: 'ts-auto-test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin123', ADMIN_NAME: 'SystemAdmin',
      UPLOADS_DIR: uploads, TIMESHEET_CONFIG_DIR: cfgDir, ...devFiles(port === PORT ? 'a' : 'b'), ...extraEnv,
    },
    stdio: 'ignore',
  });
}
const server = spawnServer(PORT);

async function waitReady(base) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${base}/api/config`); if (r.ok) return; } catch { /* 等待 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`服务未就绪：${base}`);
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
const login = async (base, username, password) => J(`${base}/api/auth/login`, null, {
  method: 'POST', body: JSON.stringify({ username, password }),
});

try {
  await waitReady(BASE);

  // ===== 1. /hospitals 四态 source：auto（项目名命中）/ auto（客户名命中）/ sys / none =====
  const lg = await login(BASE, 'admin', 'admin123');
  const tk = lg.body.token;
  const h = await J(`${BASE}/api/timesheet/hospitals`, tk);
  assert(h.status === 200 && h.body.success === true, `/hospitals 成功（HTTP ${h.status}）`);
  const rows = h.body.hospitals || [];
  assert(rows.length === 4, `绑定表按登录用户拉取本人客户医院，共 4 家（实测 ${rows.length}）`);
  const byId = Object.fromEntries(rows.map((r) => [r.hospitalId, r]));
  assert(byId.H001?.source === 'auto' && Number(byId.H001?.inProjectId) === 1001
    && byId.H001?.inProjectName === '海盐县人民医院信息科项目',
    `H001 source=auto（项目名命中）：${JSON.stringify(byId.H001 && [byId.H001.source, byId.H001.inProjectId])}`);
  assert(byId.H002?.source === 'auto' && Number(byId.H002?.inProjectId) === 1002,
    `H002 source=auto（客户名命中）：${JSON.stringify(byId.H002 && [byId.H002.source, byId.H002.inProjectId])}`);
  assert(byId.H003?.source === 'sys' && Number(byId.H003?.inProjectId) === 3003
    && byId.H003?.inProjectName === '妇幼老项目',
    `H003 source=sys（Configs 固定绑定兜底）：${JSON.stringify(byId.H003 && [byId.H003.source, byId.H003.inProjectId])}`);
  assert(byId.H004?.source === 'none' && Number(byId.H004?.inProjectId) === 0,
    `H004 source=none（自动未命中且无系统默认）：${JSON.stringify(byId.H004 && [byId.H004.source, byId.H004.inProjectId])}`);

  // ===== 2. own > sys：个人绑定覆盖后 source 变 own =====
  const putOwn = await J(`${BASE}/api/timesheet/my-config`, tk, {
    method: 'PUT',
    body: JSON.stringify({ bindings: { H003: { hospitalName: '海盐县妇幼保健院', inProjectId: 3009, inProjectName: '个人绑定的妇幼项目' } } }),
  });
  assert(putOwn.body?.success === true, `保存个人绑定 H003 → 项目 3009`);
  const h2 = await J(`${BASE}/api/timesheet/hospitals`, tk);
  const ownRow = (h2.body.hospitals || []).find((r) => r.hospitalId === 'H003');
  assert(ownRow?.source === 'own' && Number(ownRow?.inProjectId) === 3009,
    `个人绑定后 H003 source=own（个人优先于系统默认）：${JSON.stringify(ownRow && [ownRow.source, ownRow.inProjectId])}`);

  // ===== 3. 非平台管理员访问 /server-config → 403 =====
  const mk = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'reporter1', name: '普通上报员', password: 'rep12345678', role: 'reporter' }),
  });
  assert(mk.status === 201 || mk.status === 200, `新建普通用户 reporter1`);
  const rlg = await login(BASE, 'reporter1', 'rep12345678');
  const rtk = rlg.body.token;
  const g1 = await J(`${BASE}/api/timesheet/server-config`, rtk);
  const p1 = await J(`${BASE}/api/timesheet/server-config`, rtk, {
    method: 'PUT', body: JSON.stringify({ token: 'hack-token' }),
  });
  assert(g1.status === 403 && p1.status === 403, `非平台管理员 GET/PUT server-config 均 403（GET ${g1.status}/PUT ${p1.status}）`);

  // ===== 4. 管理员 GET：掩码展示、不回显明文、fromEnv=false =====
  const g2 = await J(`${BASE}/api/timesheet/server-config`, tk);
  assert(g2.status === 200 && g2.body.success === true && g2.body.fromEnv === false,
    `管理员 GET server-config 成功且 fromEnv=false`);
  assert(g2.body.url === `http://127.0.0.1:${mcpPort}/mcp`, `GET 返回服务地址（mcp.json 的 Url）`);
  assert(g2.body.hasToken === true && g2.body.tokenMasked === `${ORIG_TOKEN.slice(0, 6)}…${ORIG_TOKEN.slice(-4)}`,
    `tokenMasked=前6…后4（实测 ${g2.body.tokenMasked}）`);
  assert(!JSON.stringify(g2.body).includes(ORIG_TOKEN), `响应不包含 token 明文（零泄露）`);

  // ===== 5. PUT 更新 token：写回文件（Bearer 归一+保留 Url+自动备份） =====
  const NEW_RAW = 'Bearer new-token-1234abcd-5678efgh';
  const NEW_TOKEN = 'new-token-1234abcd-5678efgh';
  const pu = await J(`${BASE}/api/timesheet/server-config`, tk, {
    method: 'PUT', body: JSON.stringify({ token: NEW_RAW }),
  });
  assert(pu.status === 200 && pu.body.success === true, `PUT 更新 token 成功（兼容 Bearer 前缀）`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(cfgDir, 'mcp.json'), 'utf8'));
  const srvCfg = onDisk.McpServers['PMIS-MCP'];
  assert(srvCfg.Headers.Authorization === `Bearer ${NEW_TOKEN}` && srvCfg.Url === `http://127.0.0.1:${mcpPort}/mcp`,
    `mcp.json 写回：Bearer 归一 + 保留 Url`);
  const bakDir = path.join(cfgDir, 'backup');
  const baks = fs.existsSync(bakDir) ? fs.readdirSync(bakDir).filter((f) => f.startsWith('mcp-')) : [];
  assert(baks.length >= 1, `自动备份生成（backup/${baks[0] || '缺失'}）`);
  if (baks.length) {
    const bakTxt = fs.readFileSync(path.join(bakDir, baks[0]), 'utf8');
    assert(bakTxt.includes(ORIG_TOKEN), `备份内容是更新前的旧 token`);
  }

  // ===== 6. 更新后：GET 掩码换新 + MCP 侧立即收到新 Authorization（即时生效） =====
  const g3 = await J(`${BASE}/api/timesheet/server-config`, tk);
  assert(g3.body.tokenMasked === `${NEW_TOKEN.slice(0, 6)}…${NEW_TOKEN.slice(-4)}`,
    `更新后 tokenMasked 换新（实测 ${g3.body.tokenMasked}）`);
  lastMcpAuth = '';
  await J(`${BASE}/api/timesheet/hospitals`, tk);
  assert(lastMcpAuth === `Bearer ${NEW_TOKEN}`,
    `后续 MCP 调用立即携带新 token（无需重启）：${lastMcpAuth.slice(0, 24)}…`);

  // ===== 7. 审计 UPDATE_TS_TOKEN：只记长度不落明文 =====
  const au = await J(`${BASE}/api/audit?action=UPDATE_TS_TOKEN`, tk);
  const arows = au.body?.rows || au.body?.items || [];
  const hit = arows.find((r) => r.action === 'UPDATE_TS_TOKEN');
  assert(!!hit, `审计存在 UPDATE_TS_TOKEN 记录`);
  const detail = String(hit?.detail || '');
  assert(detail.includes(String(NEW_TOKEN.length)) && !detail.includes(NEW_TOKEN),
    `审计 detail 只记长度（${detail}），不落 token 明文`);

  // ===== 8. env PMIS_MCP_TOKEN 覆盖：fromEnv=true、PUT 被拒 =====
  const server2 = spawnServer(PORT2, { PMIS_MCP_TOKEN: 'env-token-aaaa-bbbb' });
  try {
    await waitReady(BASE2);
    const lg2 = await login(BASE2, 'admin', 'admin123');
    const tk2 = lg2.body.token;
    const ge = await J(`${BASE2}/api/timesheet/server-config`, tk2);
    assert(ge.body?.fromEnv === true && ge.body?.tokenMasked === 'env-to…bbbb',
      `env 覆盖时 GET：fromEnv=true 且掩码取 env token（实测 ${ge.body?.tokenMasked}）`);
    const pe = await J(`${BASE2}/api/timesheet/server-config`, tk2, {
      method: 'PUT', body: JSON.stringify({ token: 'another-token' }),
    });
    assert(pe.body?.success === false && String(pe.body?.message).includes('环境变量'),
      `env 覆盖时 PUT 被拒并提示先移除环境变量`);
  } finally {
    try { server2.kill(); } catch { /* ignore */ }
  }

  // ===== 9. PUT 校验：空 token / 超长 =====
  const pe1 = await J(`${BASE}/api/timesheet/server-config`, tk, { method: 'PUT', body: JSON.stringify({ token: '  ' }) });
  const pe2 = await J(`${BASE}/api/timesheet/server-config`, tk, { method: 'PUT', body: JSON.stringify({ token: 'x'.repeat(501) }) });
  assert(pe1.body?.success === false, `空 token 拒绝`);
  assert(pe2.body?.success === false && String(pe2.body?.message).includes('500'), `超长（>500）拒绝`);
} finally {
  try { server.kill(); } catch { /* ignore */ }
  try { mcpSrv.close(); } catch { /* ignore */ }
  try { wxpSrv.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpbase, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
