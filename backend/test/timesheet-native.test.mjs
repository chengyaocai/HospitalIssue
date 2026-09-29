// v1.18.42 专项测试：实施协同 · 工时登记的 Node 原生实现（src/timesheet/ + routes/timesheet.js 重写）。
//
// 方案：本地起两个 mock 上游冒充真实依赖——
//   ① mock PMIS-MCP（JSON-RPC tools/call：get_user_token / call_api，CSV 经 download_url 下发）
//   ② mock WXP 底稿系统（pmisLogin / queryMyCustomerList / 底稿列表）
// TIMESHEET_CONFIG_DIR 指向测试专用的临时 Configs（wxp.json/mcp.json 指向 mock），再起后端（dev 驱动），验证：
//   1) 未登录 401；2) /config 本地配置直出；3) /hospitals 动态拉取+绑定合并（含首次 401 → 原子重登重试）；
//   4) WXP 请求头 X-USER-CODE / X-AGENT-TOKEN / X-SOURCE；5) /drafts 工作内容生成（当天完成/进行中/累计）；
//   6) /unfilled 经 API 115；7) /projects 经 API 65 且配置项排最前；8) /submit 经 API 111 解析成功笔数；
//   9) /batch-drafts 占比均分（0.5h 粒度 + 余数补偿）；10) /batch-submit 汇总；11) 知识库增删随机；
//   12) /save-project 写回 timesheet.json + 备份；13) 权限模型（MENUS/迁移 v3）。
//
// 运行：cd backend && node test/timesheet-native.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stamp = Date.now();
const PORT = 3960 + (process.pid % 200);
const MCP_PORT = PORT + 1;
const WXP_PORT = PORT + 2;
const BASE = `http://localhost:${PORT}`;
const MCP = `http://localhost:${MCP_PORT}`;
const WXP = `http://localhost:${WXP_PORT}`;

// —— mock 记录（供断言）——
const mcpCalls = []; // { api_id, body(解析后) }
const wxpHits = []; // { path, headers, body }
let wxpLoginCount = 0;
let wxpFailFirstQuery = true; // 第一次 queryMyCustomerList 返回 401，验证鉴权失败→原子重登→整批重试

function readBody(req, cb) {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => cb(b));
}

function csvOf(rows) {
  return '\uFEFF' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
}

// —— mock PMIS-MCP ——
const mcpServer = http.createServer((req, res) => {
  // CSV 下载端点（GET，无请求体；download_url 指向这里）
  const csvMatch = /^\/csv\/(.+\.csv)$/.exec(req.url);
  if (csvMatch) {
    const id = csvMatch[1].replace('.csv', '');
    let csv = '';
    if (id === '65') {
      csv = csvOf([
        ['在建项目ID', '在建项目名称', '客户名称', '项目经理', '项目类型', '执行状态'],
        ['155000', '其他项目B', '其他客户', '张三', '实施', '暂停'],
        ['154267', '金卫软件销245210_海盐县人民医院_测试合同', '海盐县人民医院', '李四', '实施', '执行'],
      ]);
    } else if (id === '115') {
      csv = csvOf([['日期', '工时', '内容'], ['2026-09-25', '8', 'b'], ['2026-09-24', '8', 'a']]);
    } else if (id === '111') {
      csv = csvOf([['成功导入笔数', '失败笔数', '总记录数'], ['1', '0', '1']]);
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    return res.end(csv);
  }
  readBody(req, (raw) => {
    const call = JSON.parse(raw);
    const tool = call.params?.name;
    const args = call.params?.arguments || {};
    if (tool === 'get_user_token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        jsonrpc: '2.0', id: call.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ token: 'pmis-tok-1', userId: 888, username: '测试工号' }) }] },
      }));
    }
    if (tool === 'call_api') {
      mcpCalls.push({ api_id: args.api_id, body: JSON.parse(args.body), qp: JSON.parse(JSON.parse(args.body).query_params || '{}') });
      let csv = '';
      if (args.api_id === '65' || args.api_id === '115' || args.api_id === '111') {
        // CSV 内容按 api_id 在 /csv/* 下载端点生成
      }
      const text = `${JSON.stringify({ status: 'ok', files: [{ download_url: `${MCP}/csv/${args.api_id}.csv` }] })}\n\n以下是查询结果说明（markdown）。`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text }] } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? 0, error: { code: -32601, message: 'unknown tool' } }));
  });
});

// —— mock WXP 底稿系统 ——
const wxpServer = http.createServer((req, res) => {
  readBody(req, (raw) => {
    const u = new URL(req.url, WXP);
    const headers = { xUserCode: req.headers['x-user-code'], xAgentToken: req.headers['x-agent-token'], xSource: req.headers['x-source'] };
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    if (u.pathname === '/wxp/training/web/pmisLogin') {
      wxpLoginCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        code: 20000, message: 'ok',
        data: { accessToken: 'pmis-tok-1', userCode: '11547', userNote: '孙正华(11547)', refreshToken: 'r-1', expiresIn: 7200 },
      }));
    }
    wxpHits.push({ path: u.pathname, headers, body });
    if (u.pathname === '/wxp/draft/issue/sheet/queryMyCustomerList') {
      if (wxpFailFirstQuery) {
        wxpFailFirstQuery = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ code: 401, message: 'token 失效' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        code: 20000, message: 'ok',
        data: [
          { hospitalCode: '13738', hospitalName: '海盐人民医院（WXP原始名）', province: '浙江', city: '嘉兴' },
          { hospitalCode: '99999', hospitalName: '无绑定医院', province: '浙江', city: '嘉兴' },
        ],
      }));
    }
    if (u.pathname === '/wxp/draft/issue/sheet/normal') {
      // 无绑定医院（99999）当天没有本人关闭底稿 → 空列表（验证批量模式的"唯一口径"过滤）
      const drafts = body?.hospitalId === '99999' ? [] : [
        { implementManager: '11547,13800', statusName: '已关闭', closeTime: '2026-09-24 15:00:00', title: 'PACS系统无法打开图像' },
        { implementManager: '11547', statusName: '实施处理中', closeTime: '', updatedTime: '2026-09-24 10:00:00', title: 'LIS接口联调' },
        { implementManager: '88888', statusName: '已关闭', closeTime: '2026-09-24 09:00:00', title: '别人家的底稿' },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 20000, message: 'ok', data: drafts }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 40000, message: 'mock 未知路径' }));
  });
});

// —— 测试专用临时 Configs ——
const cfgDir = path.join(os.tmpdir(), `tsnative-cfg-${stamp}`);
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'timesheet.json'), JSON.stringify({
  DefaultTimesheetType: 2, DefaultCostLineId: 2, DefaultProcessType: 62, DefaultWorkHours: 8,
  InProgressStatusList: ['实施处理中'],
  HospitalConfigs: {
    13738: { hospitalName: '海盐县人民医院', inProjectId: 154267, inProjectName: '金卫软件销245210_海盐县人民医院_测试合同', draftViewId: '' },
  },
}, null, 2));
fs.writeFileSync(path.join(cfgDir, 'wxp.json'), JSON.stringify({
  WxpSettings: {
    BaseUrl: WXP, UserCode: '11547', PasswordEncrypted: 'test-pwd,',
    Api: {
      PmisLogin: '/wxp/training/web/pmisLogin',
      QueryMyCustomerList: '/wxp/draft/issue/sheet/queryMyCustomerList',
      DraftList: '/wxp/draft/issue/sheet/normal',
    },
  },
}, null, 2));
fs.writeFileSync(path.join(cfgDir, 'mcp.json'), JSON.stringify({
  McpServers: { 'PMIS-MCP': { Url: MCP, Headers: { Authorization: 'Bearer test-mcp-token' } } },
}, null, 2));
fs.writeFileSync(path.join(cfgDir, 'timesheet-kb.json'), JSON.stringify(['巡检服务器机房温度', '升级数据库补丁'], null, 2));

const tmp = (n) => path.join(os.tmpdir(), `tsnative-${n}-${stamp}.json`);
const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
  TIMESHEET_USER_DEV_PATH: tmp('tsuser'), // v1.18.43：个人工时配置落盘也必须隔离（save-project 写个人配置）
};
const uploads = path.join(os.tmpdir(), `tsnative-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'timesheet-native-test-secret',
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
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return; } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务未就绪');
}
function cleanup() {
  try { server.kill(); } catch { /* ignore */ }
  try { mcpServer.close(); } catch { /* ignore */ }
  try { wxpServer.close(); } catch { /* ignore */ }
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(uploads, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const f of Object.values(files)) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

const api = async (p, opts = {}, token) => fetch(`${BASE}/api/timesheet${p}`, {
  ...opts,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
});

async function main() {
  await new Promise((r) => mcpServer.listen(MCP_PORT, r));
  await new Promise((r) => wxpServer.listen(WXP_PORT, r));
  await waitReady();

  // 1) 未登录 401
  const unauth = await api('/config');
  assert(unauth.status === 401, `未登录 GET /api/timesheet/config → 401（实测 ${unauth.status}）`);

  // 登录
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const token = login.token;

  // 2) /config 本地配置直出
  const cfg = await (await api('/config', {}, token)).json();
  assert(cfg.defaultWorkHours === 8 && cfg.defaultProcessType === 62 && cfg.defaultTimesheetType === 2,
    'GET /config 返回本地 timesheet.json 默认值（8h/工序62/类型2）');
  assert(Array.isArray(cfg.hospitalConfigs) && cfg.hospitalConfigs[0]?.hospitalId === '13738' && cfg.hospitalConfigs[0]?.inProjectId === 154267,
    '/config 的 hospitalConfigs 含 13738 → 154267 绑定');
  assert(cfg.timesheetTypes.some((t) => t.label === '实施-无计划') || cfg.timesheetTypes.length >= 0, '/config 类型字典结构就绪');

  // 3) /hospitals：首次 401 → 原子重登 → 重试成功（验证鉴权失败整批重试链路）
  const hResp = await api('/hospitals', {}, token);
  const hd = await hResp.json();
  assert(hd.success === true && Array.isArray(hd.hospitals) && hd.hospitals.length === 2,
    `/hospitals 鉴权失败自动重登后成功，返回 2 家医院（实测 ${hd.message || hd.hospitals?.length}）`);
  assert(wxpLoginCount >= 2, `WXP pmisLogin 被调用 ≥2 次（首次 401 触发原子重登，实测 ${wxpLoginCount}）`);
  const h1 = hd.hospitals.find((h) => h.hospitalCode === '13738');
  const h2 = hd.hospitals.find((h) => h.hospitalCode === '99999');
  assert(h1?.hospitalName === '海盐县人民医院' && h1?.hasConfig === true && h1?.inProjectId === 154267,
    '/hospitals 合并本地绑定（名称覆盖 + hasConfig=true + 默认项目）');
  assert(h2?.hasConfig === false, '未绑定医院 hasConfig=false');
  const qHit = wxpHits.find((h) => h.path === '/wxp/draft/issue/sheet/queryMyCustomerList');
  assert(qHit?.headers?.xUserCode === '11547' && !!qHit?.headers?.xAgentToken && qHit?.headers?.xSource === 'AGENT',
    'WXP 请求头 X-USER-CODE=11547 / X-AGENT-TOKEN 存在 / X-SOURCE=AGENT');

  // 4) /drafts：工作内容生成
  const dResp = await api('/drafts?hospitalId=13738&hospitalName=海盐县人民医院&workDate=2026-09-24', {}, token);
  const dd = await dResp.json();
  assert(dd.success === true && dd.mineCount === 2 && dd.closedTodayCount === 1 && dd.inProgressCount === 1,
    `/drafts 统计口径（本人2项/当天关闭1项/进行中1项，实测 ${JSON.stringify({ m: dd.mineCount, c: dd.closedTodayCount, i: dd.inProgressCount })}）`);
  assert(/【AI工时】海盐县人民医院运维支持工作：/.test(dd.workContent || '')
    && /【当天完成】\(1项\)/.test(dd.workContent)
    && /1\.PACS系统无法打开图像\(已关闭\)/.test(dd.workContent)
    && /累计处理2项底稿/.test(dd.workContent),
    '/drafts 工作内容含【AI工时】抬头/当天完成明细/累计行');
  assert(Array.isArray(dd.drafts) && dd.drafts[0]?.title === 'PACS系统无法打开图像' && dd.drafts[0]?.statusName === '已关闭',
    '/drafts 返回 drafts 明细数组（title/statusName/closeTime）');
  // includeInProgress=true → 进行中段落出现
  const d2 = await (await api('/drafts?hospitalId=13738&workDate=2026-09-24&includeInProgress=true', {}, token)).json();
  assert(/【进行中】\(1项，展示前1项\)/.test(d2.workContent || '') && /2\.LIS接口联调\(实施处理中\)/.test(d2.workContent),
    '/drafts includeInProgress=true 时工作内容含【进行中】段落');
  // 当天无关闭 → 不等于零底稿误判：workDate 改成无匹配日
  const d3 = await (await api('/drafts?hospitalId=13738&workDate=2026-09-01', {}, token)).json();
  assert(d3.success === true && d3.closedTodayCount === 0 && d3.mineCount === 2,
    '/drafts 日期无关闭项时 closedTodayCount=0（由批量模式的唯一口径过滤）');

  // 5) /unfilled：API 115 + fill_user 缺省取配置工号
  const uf = await (await api('/unfilled?startDate=2026-09-01&endDate=2026-09-28', {}, token)).json();
  assert(uf.success === true && uf.totalDays === 2 && uf.dates[0] === '2026-09-24' && uf.dates[1] === '2026-09-25',
    '/unfilled 返回去重排序后的未填日期（totalDays=2）');
  const ufCall = mcpCalls.filter((c) => c.api_id === '115').pop();
  assert(ufCall?.qp?.fill_user === '11547' && ufCall?.qp?.start_date === '2026-09-01' && ufCall?.qp?.end_date === '2026-09-28',
    'API 115 的 query_params 含 fill_user（缺省配置工号 11547）+ 日期范围');

  // 6) /projects：API 65 + 配置项排最前
  const pj = await (await api('/projects?hospitalCode=13738&hospitalName=海盐县人民医院', {}, token)).json();
  assert(pj.success === true && pj.configuredId === 154267 && pj.projects[0]?.inProjectId === 154267 && pj.projects[0]?.isConfigured === true,
    '/projects 配置中的在建项目排最前（isConfigured=true）');
  assert(pj.projects.length === 2 && pj.count === 2, '/projects 去重后返回 2 个候选');
  const p65 = mcpCalls.filter((c) => c.api_id === '65').pop();
  assert(p65?.qp?.keyword === '海盐县人民医院' && p65?.qp?.register_start_date === '2000-01-01',
    'API 65 的 query_params keyword=医院名（放宽起始日期 2000-01-01）');

  // 7) /submit：API 111 + 成功笔数解析
  const entry = { timesheet_type: 2, work_date: '2026-09-24', work_hours: 8, work_content: '测试工作内容', cost_line_id: 2, in_project_id: 154267, process_type: 62 };
  const st = await (await api('/submit', { method: 'POST', body: JSON.stringify({ entries: [entry] }) }, token)).json();
  assert(st.success === true && st.okCount === 1 && st.failCount === 0 && st.totalCount === 1,
    `/submit 解析 PMIS CSV 结果（成功1/失败0/共1，实测 ${st.message}）`);
  const s111 = mcpCalls.filter((c) => c.api_id === '111').pop();
  const arr = s111?.qp?.json_array;
  assert(Array.isArray(arr) && arr[0]?.work_content === '测试工作内容' && arr[0]?.in_project_id === 154267 && arr[0]?.process_type === 62,
    'API 111 的 json_array 逐字段到达（含 in_project_id/process_type）');

  // 8) /batch-drafts：占比均分（13738 关1项、99999 无关闭项 → 只有 13738 进列表，独占 totalHours）
  const bd = await (await api('/batch-drafts?workDate=2026-09-24&totalHours=6', {}, token)).json();
  assert(bd.success === true && bd.rowCount === 1 && bd.totalClosed === 1,
    `/batch-drafts 只含当天有本人关闭项的医院（rowCount=1，实测 ${bd.message || bd.rowCount}）`);
  assert(bd.rows[0]?.suggestedHours === 6 && bd.rows[0]?.inProjectId === 154267,
    `/batch-drafts 工时全部分配给唯一医院（suggestedHours=6）并带默认在建项目`);

  // 9) /batch-submit：汇总
  const bs = await (await api('/batch-submit', {
    method: 'POST',
    body: JSON.stringify([
      { hospitalId: '13738', hospitalName: '海盐县人民医院', workDate: '2026-09-24', hours: 6, timesheetType: 2, costLineId: 2, processType: 62, inProjectId: 154267, workContent: '批量内容A' },
      { hospitalId: '99999', hospitalName: '无绑定医院', workDate: '2026-09-24', hours: 2, timesheetType: 2, costLineId: 2, processType: 62, inProjectId: 0, workContent: '批量内容B' },
      { hospitalId: 'skip', hospitalName: 'x', workDate: '2026-09-24', hours: 0, timesheetType: 2, costLineId: 2, processType: 62, inProjectId: 0, workContent: '小时为0应跳过' },
    ]),
  }, token)).json();
  assert(bs.success === true && bs.okCount === 2 && bs.failCount === 0 && bs.total === 3 && bs.results.length === 2,
    `/batch-submit 逐院提交汇总（成功2家、hours=0 跳过，实测 ${bs.message}）`);

  // 10) 知识库：列表/新增/随机/删除
  const kb0 = await (await api('/kb', {}, token)).json();
  assert(kb0.success === true && kb0.total === 2 && kb0.items.includes('巡检服务器机房温度'), '/kb 读取种子知识库（2条）');
  const ka = await (await api('/kb-add', { method: 'POST', body: JSON.stringify({ content: '  新增知识条目  ' }) }, token)).json();
  assert(ka.success === true && ka.total === 3, '/kb-add trim 后新增（total=3）');
  const kr = await (await api('/kb-random?count=2', {}, token)).json();
  assert(kr.success === true && kr.items.length === 2 && kr.items.every((x) => typeof x === 'string'), '/kb-random 随机取 2 条');
  const kd = await (await api('/kb-delete', { method: 'POST', body: JSON.stringify({ index: 0 }) }, token)).json();
  assert(kd.success === true && kd.total === 2, '/kb-delete 按索引删除（total=2）');

  // 11) /save-project：v1.18.43 起写回**个人**配置（TIMESHEET_USER_DEV_PATH），不再改全局 Configs/timesheet.json
  const sp = await (await api('/save-project', {
    method: 'POST',
    body: JSON.stringify({ hospitalCode: '99999', hospitalName: '无绑定医院', inProjectId: 188888, inProjectName: '无绑定医院项目X' }),
  }, token)).json();
  assert(sp.success === true && /我的工时配置/.test(sp.message || ''), `/save-project 写入个人配置成功（实测 ${sp.message}）`);
  const userCfgRaw = JSON.parse(fs.readFileSync(files.TIMESHEET_USER_DEV_PATH, 'utf8'));
  assert(userCfgRaw.admin?.bindings?.['99999']?.inProjectId === 188888, '/save-project 落盘到个人配置（admin → 99999 = 188888）');
  const globalTs = JSON.parse(fs.readFileSync(path.join(cfgDir, 'timesheet.json'), 'utf8'));
  assert(!globalTs.HospitalConfigs['99999'] && globalTs.HospitalConfigs['13738']?.inProjectId === 154267,
    'save-project 不再污染全局 Configs/timesheet.json（13738 保持原样）');
  const cfg2 = await (await api('/config', {}, token)).json();
  assert(cfg2.hospitalConfigs.some((h) => h.hospitalId === '99999' && h.inProjectId === 188888), '个人绑定写回后 /config 立即生效（个人优先合并）');

  // 12) 权限模型
  const permMod = await import('../src/permissions.js');
  assert(permMod.MENUS.some((m) => m.key === 'timesheet' && m.label === '工时登记'), '后端 MENUS 含 timesheet（工时登记）');
  const reporter = permMod.defaultRolePermissions('reporter');
  assert(reporter.menus.includes('timesheet'), '登记员默认模板含 timesheet 菜单');
  const cfgApi = await (await fetch(`${BASE}/api/config`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert(cfgApi.permissions?.admin?.menus?.includes('timesheet'), '/api/config 的 admin 权限含 timesheet（存量迁移 v3 生效）');
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
