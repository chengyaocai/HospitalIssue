// v1.18.24：底稿登记清单导出端点专项测试（dev 驱动，真实起后端）。
// 覆盖：仅导出已通过问题、字段映射规则（draft-operations skill）、keyword 过滤、
//       org 隔离、issue.export 权限、空结果显式报错、Sheet2 登记要点内容。
// 运行：node test/draft-export.test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import { DRAFT_COLUMNS, draftRegisterLines } from '../src/services/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3418;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `${n}-draftexport-${stamp}.json`);
const tmpUploads = path.join(os.tmpdir(), `uploads-draftexport-${stamp}`);

const env = {
  ...process.env,
  DB_DRIVER: 'dev',
  DEV_DB_PATH: tmp('issues'),
  DEV_USERS_PATH: tmp('users'),
  AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'),
  NOTIFICATIONS_DEV_PATH: tmp('notifications'),
  CHAT_DEV_PATH: tmp('chat'),
  ORGS_DEV_PATH: tmp('orgs'),
  SCHEDULE_DEV_PATH: tmp('schedules'),
  UPLOADS_DIR: tmpUploads,
  PORT: String(PORT),
};
const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env, stdio: 'ignore' });

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
async function jsonOf(res) { return res.json().catch(() => ({})); }

async function createProblem(body) {
  const res = await authFetch('/api/problems', { method: 'POST', body: JSON.stringify(body) });
  assert(res.status === 201, `创建问题「${body.title}」`);
  return jsonOf(res);
}
async function approve(id) {
  const res = await authFetch(`/api/problems/${id}/audit`, { method: 'POST', body: JSON.stringify({ result: 'approve' }) });
  assert(res.status === 200, `审核通过问题 #${id}`);
}
// 解析导出的 xlsx：返回 { sheets, rows }（rows 为对象数组，按 Sheet1 表头映射）
async function fetchDraftWorkbook(url = '/api/problems/export-draft') {
  const res = await authFetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('底稿登记清单');
  const headers = (ws.getRow(1).values || []).slice(1);
  const rows = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const vals = (ws.getRow(i).values || []).slice(1);
    const o = {};
    headers.forEach((h, idx) => { o[h] = vals[idx] ?? ''; });
    rows.push(o);
  }
  return { res, wb, rows };
}

function cleanup() {
  server.kill();
  for (const f of [tmp('issues'), tmp('users'), tmp('audit'), tmp('settings'), tmp('notifications'), tmp('chat'), tmp('orgs'), tmp('schedules')]) {
    try { fs.unlinkSync(f); } catch {}
  }
  try { fs.rmSync(tmpUploads, { recursive: true, force: true }); } catch {}
}

let p1, p2, p4, p3;
try {
  await waitReady();

  // ---- 权限：未登录 401 ----
  assert((await fetch(BASE + '/api/problems/export-draft')).status === 401, '未登录导出底稿登记 -> 401');

  // ---- 登录（admin 默认具备 issue.export）----
  const loginRes = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  assert(loginRes.status === 200, 'admin 登录');
  TOKEN = (await jsonOf(loginRes)).token;

  // ---- 造数：默认机构 3 通过 + 1 待审核（故障/高、需求/中、咨询/低 覆盖映射规则）----
  p1 = await createProblem({ title: 'PACS影像传输故障', department: '影像科', reporter: '张三', type: '故障', severity: '高', description: '影像无法传输到报告系统', softwareSystem: 'PACS' });
  p2 = await createProblem({ title: '体检中心报告导出需求', department: '体检中心', reporter: '李四', type: '需求', severity: '中', description: '希望增加批量导出功能', softwareSystem: 'HIS' });
  p4 = await createProblem({ title: '护士站打印机咨询', department: '护理部', reporter: '王五', type: '咨询', severity: '低', description: '咨询打印设置', softwareSystem: '' });
  p3 = await createProblem({ title: '未审核的需求问题', department: '信息科', reporter: '赵六', type: '需求', severity: '高', description: '尚未通过审核不应导出', softwareSystem: 'HIS' });
  await approve(p1.id);
  await approve(p2.id);
  await approve(p4.id);   // 最后通过 -> audit_at 最新 -> 倒序第一行

  // ---- 导出 & 解析 ----
  const { res, wb, rows } = await fetchDraftWorkbook();
  assert(res.status === 200 && (res.headers.get('content-type') || '').includes('spreadsheetml'), '导出返回 200 且为 xlsx 内容类型');
  assert(!!wb.getWorksheet('底稿登记清单') && !!wb.getWorksheet('登记要点'), '含「底稿登记清单」「登记要点」两个 sheet');
  const headers = (wb.getWorksheet('底稿登记清单').getRow(1).values || []).slice(1);
  assert(JSON.stringify(headers) === JSON.stringify(DRAFT_COLUMNS.map((c) => c.header)), 'Sheet1 表头与 DRAFT_COLUMNS 一致（表头存在）');
  assert(rows.length === 3 && !rows.some((r) => r['标题'] === p3.title), '仅导出已通过问题（待审核的 p3 不出现）');
  assert(rows[0]['标题'] === p4.title, '按审核时间倒序（最后通过的排第一行）');

  // ---- 字段映射规则 ----
  const row1 = rows.find((r) => r['标题'] === p1.title);
  assert(row1['底稿类型'] === '1-Bug' && row1['底稿分类'] === '1-系统BUG类' && row1['优先级'] === '2-A级-紧急',
    '故障+高 -> 1-Bug / 1-系统BUG类 / 2-A级-紧急');
  const row2 = rows.find((r) => r['标题'] === p2.title);
  assert(row2['底稿类型'] === '2-需求' && row2['底稿分类'] === '2-需求改造类' && row2['优先级'] === '3-B级-急',
    '需求+中 -> 2-需求 / 2-需求改造类 / 3-B级-急');
  const row4 = rows.find((r) => r['标题'] === p4.title);
  assert(row4['底稿类型'] === '' && row4['底稿分类'] === '' && row4['优先级'] === '4-C级-一般',
    '咨询(其它)+低 -> 类型/分类留空 / 4-C级-一般');
  assert(row1['业务分类方向'] === 'PACS' && row4['业务分类方向'] === '', '业务分类方向 = 问题「软件系统」字段');
  assert(row1['businessTypeId'] === '' && row1['productId'] === '' && row1['在建项目accountProjectId'] === '' && row1['科室成员电话'] === '' && row1['提需人角色'] === '',
    'businessTypeId / productId / accountProjectId / 电话 / 提需人角色 均留空待人工');
  assert(rows.every((r) => r['来源'] === '2-实施提需') && /^\d{4}-\d{2}-\d{2}$/.test(row1['登记日期']),
    '来源固定 2-实施提需；登记日期为 yyyy-MM-dd（审核通过时间）');

  // ---- Sheet2 登记要点 ----
  const tips = [];
  const ws2 = wb.getWorksheet('登记要点');
  for (let i = 1; i <= ws2.rowCount; i++) tips.push(String(ws2.getRow(i).values[1] || ''));
  assert(draftRegisterLines().every((l) => tips.includes(l)) && tips.some((t) => t.includes('projectId')) && tips.some((t) => t.includes('status=2')),
    '登记要点 sheet 含全部防错规则（projectId / status=2 等）');

  // ---- keyword 过滤 + 空结果显式报错 ----
  const kwRes = await fetchDraftWorkbook('/api/problems/export-draft?keyword=' + encodeURIComponent('PACS'));
  assert(kwRes.rows.length === 1 && kwRes.rows[0]['标题'] === p1.title, 'keyword=PACS 仅命中 1 条');
  const emptyRes = await authFetch('/api/problems/export-draft?keyword=' + encodeURIComponent('绝不存在的关键字xyz'));
  assert(emptyRes.status === 400 && (await jsonOf(emptyRes)).error === '当前没有已通过的问题可导出', '空结果 400 + 明确提示文案');

  async function switchOrg(orgId) {
  // switch-org 会重签携带新机构声明的 token，必须回写 TOKEN，否则后续请求仍在原机构
  const res = await authFetch('/api/auth/switch-org', { method: 'POST', body: JSON.stringify({ orgId }) });
  assert(res.status === 200, `切换机构 -> org#${orgId}`);
  TOKEN = (await jsonOf(res)).token;
}

// ---- org 隔离：其它机构的问题不出现在当前机构导出中 ----
  const orgRes = await authFetch('/api/orgs', { method: 'POST', body: JSON.stringify({ name: '第二医院' }) });
  const orgB = await jsonOf(orgRes);
  assert(orgRes.status === 201 && !!orgB.id, '平台管理员创建第二机构');
  await switchOrg(orgB.id);
  const pB = await createProblem({ title: '第二医院专属问题', department: '内科', reporter: '钱七', type: '故障', severity: '中', description: '属于机构B的问题', softwareSystem: 'LIS' });
  await approve(pB.id);
  await switchOrg(1);
  const backHome = await fetchDraftWorkbook();
  assert(backHome.rows.length === 3 && !backHome.rows.some((r) => r['标题'] === pB.title), '切回默认机构导出：机构B的问题不出现（org 隔离）');
  await switchOrg(orgB.id);
  const inOrgB = await fetchDraftWorkbook();
  assert(inOrgB.rows.length === 1 && inOrgB.rows[0]['标题'] === pB.title && inOrgB.rows[0]['医院'] === '第二医院',
    '机构B视角导出：仅见本机构问题，医院列为机构名');
} catch (e) {
  failed++;
  console.error('  FAIL 异常：' + (e && e.message ? e.message : e));
} finally {
  cleanup();
}

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
