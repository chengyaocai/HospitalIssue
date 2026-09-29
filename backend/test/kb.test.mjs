// v1.18.27 端到端：运维知识库（派生视图，不加新表）。
//
// 规则钉住：
//   1) 所有写了「处理说明」（resolution trim 后非空）的问题自动进入 GET /api/problems/kb；
//      空串 / 纯空格 resolution 不进；
//   2) 已删除（回收站）问题不进；
//   3) 机构隔离：机构 B 看不到机构 A 的条目（跨机构按 id 读写一律 404 的同一隔离语义）；
//   4) keyword 能搜中「处理说明」正文里的词（与普通列表的关键差异），
//      也能搜标题 / 软件系统；大小写不敏感；
//   5) type 过滤生效；
//   6) 响应形状 { rows, total, page, pageSize }，分页正确；
//   7) 未登录 401；
//   8) 排序默认 updated_at desc（先造的条目后来改过的排前面）。
//
// 运行：cd backend && node test/kb.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3960 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `kb-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `kb-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'kb-test-secret',
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
const createIssue = (tk, data) => J(`${BASE}/api/problems`, tk, { method: 'POST', body: JSON.stringify(data) });
const kb = (tk, params = '') => J(`${BASE}/api/problems/kb${params}`, tk);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await waitReady();

  // ===== 0. 登录 + 第二机构 =====
  const admin = await login('admin', 'admin123');
  assert(admin.status === 200 && admin.body.token, `平台管理员登录成功（HTTP ${admin.status}）`);
  const tk = admin.body.token;

  const mk = await J(`${BASE}/api/orgs`, tk, { method: 'POST', body: JSON.stringify({ code: 'zyy', name: '海盐县中医院' }) });
  assert(mk.status === 201 && mk.body.id, `新建机构 2 成功（id=${mk.body && mk.body.id}）`);
  const org2 = mk.body.id;

  // ===== 1. 机构 1 造数：收录 / 空串 / 纯空格 / 已删除 =====
  const a1 = await createIssue(tk, {
    title: 'HIS系统打印异常', department: '信息科', reporter: '张三', type: '故障', severity: '中', status: '已解决',
    description: '门诊医生站无法打印检验条码', handler: '李四', softwareSystem: 'HIS系统',
    resolution: '重启打印服务后恢复正常，排查为打印队列堆积',
  });
  assert(a1.status === 201 && a1.body.id, `造数 A1（resolution 非空，应收录）`);
  await sleep(20);
  const a2 = await createIssue(tk, {
    title: '空说明的问题', department: '内科', reporter: '王五', type: '咨询', severity: '低',
    description: '没有处理说明的问题不应进知识库', resolution: '',
  });
  assert(a2.status === 201, `造数 A2（resolution 空串，不应收录）`);
  await sleep(20);
  const a3 = await createIssue(tk, {
    title: '纯空格说明的问题', department: '外科', reporter: '赵六', type: '其他', severity: '低',
    description: '处理说明只有空格不应进知识库', resolution: '   ',
  });
  assert(a3.status === 201, `造数 A3（resolution 纯空格，不应收录）`);
  await sleep(20);
  const a4 = await createIssue(tk, {
    title: 'LIS接口对接需求', department: '检验科', reporter: '钱七', type: '需求', severity: '低', status: '已解决',
    description: '检验科希望与区平台对接数据', handler: '孙八', softwareSystem: 'LIS检验系统',
    resolution: '已指导信息科配置接口参数并联通测试',
  });
  assert(a4.status === 201 && a4.body.id, `造数 A4（resolution 非空，应收录）`);
  await sleep(20);
  const a5 = await createIssue(tk, {
    title: '已删除但写过说明的问题', department: '影像科', reporter: '周八', type: '故障', severity: '中', status: '已解决',
    description: 'PACS调图缓慢', resolution: '清理缓存目录后恢复',
  });
  assert(a5.status === 201 && a5.body.id, `造数 A5（有 resolution，但随后软删除）`);
  const delA5 = await J(`${BASE}/api/problems/${a5.body.id}`, tk, { method: 'DELETE' });
  assert(delA5.status === 200, `A5 软删除成功（进入回收站）`);

  // ===== 2. 机构 2 造数（机构隔离用）=====
  const sw = await J(`${BASE}/api/auth/switch-org`, tk, { method: 'POST', body: JSON.stringify({ orgId: org2 }) });
  assert(sw.status === 200 && sw.body.token, `平台管理员切换到机构 2`);
  const tk2 = sw.body.token;
  const b1 = await createIssue(tk2, {
    title: '中医院体检系统报告打印', department: '体检中心', reporter: '吴九', type: '故障', severity: '中', status: '已解决',
    description: '体检报告导出格式错乱', handler: '郑十', softwareSystem: '体检系统',
    resolution: '更换报表模板版本后恢复正常',
  });
  assert(b1.status === 201 && b1.body.id, `机构 2 造数 B1（resolution 非空）`);

  // ===== 3. 收录口径：仅 resolution 非空 + 未删除进 KB =====
  const list1 = await kb(tk);
  assert(list1.status === 200, `GET /api/problems/kb → 200（HTTP ${list1.status}）`);
  const ids1 = (list1.body.rows || []).map((r) => String(r.id));
  assert(list1.body.total === 2, `机构 1 KB total=2（A1/A4 收录；A2 空串、A3 纯空格、A5 已删除均不进。实测 ${list1.body.total}）`);
  assert(ids1.includes(String(a1.body.id)) && ids1.includes(String(a4.body.id)), `KB 收录 A1 与 A4`);
  assert(!ids1.includes(String(a2.body.id)) && !ids1.includes(String(a3.body.id)), `空串 / 纯空格 resolution 不进 KB`);
  assert(!ids1.includes(String(a5.body.id)), `已删除（回收站）问题不进 KB`);

  // ===== 4. 机构隔离 =====
  const list2 = await kb(tk2);
  const ids2 = (list2.body.rows || []).map((r) => String(r.id));
  assert(list2.status === 200 && list2.body.total === 1 && ids2.includes(String(b1.body.id)),
    `机构 2 KB 仅收录本机构 B1（total=${list2.body && list2.body.total}）`);
  assert(!ids2.includes(String(a1.body.id)) && !ids2.includes(String(a4.body.id)), `机构 2 看不到机构 1 的条目`);
  assert(!ids1.includes(String(b1.body.id)), `机构 1 看不到机构 2 的条目`);

  // ===== 5. keyword：能搜中处理说明正文（与普通列表的关键差异）=====
  const kwRes = await kb(tk, '?keyword=' + encodeURIComponent('重启打印服务'));
  const kwIds = (kwRes.body.rows || []).map((r) => String(r.id));
  assert(kwRes.status === 200 && kwRes.body.total === 1 && kwIds.includes(String(a1.body.id)),
    `keyword 搜中处理说明正文「重启打印服务」→ 仅命中 A1（total=${kwRes.body && kwRes.body.total}）`);
  const kwLower = await kb(tk, '?keyword=his');
  assert(kwLower.status === 200 && (kwLower.body.rows || []).some((r) => String(r.id) === String(a1.body.id)),
    `keyword 大小写不敏感：'his' 命中标题「HIS系统打印异常」`);
  const kwSys = await kb(tk, '?keyword=' + encodeURIComponent('LIS检验系统'));
  const sysIds = (kwSys.body.rows || []).map((r) => String(r.id));
  assert(kwSys.status === 200 && kwSys.body.total === 1 && sysIds.includes(String(a4.body.id)),
    `keyword 搜软件系统「LIS检验系统」→ 仅命中 A4`);
  const kwNone = await kb(tk, '?keyword=' + encodeURIComponent('不存在的关键词xyz'));
  assert(kwNone.status === 200 && kwNone.body.total === 0 && (kwNone.body.rows || []).length === 0,
    `keyword 无命中 → total=0 空列表（供前端空态）`);

  // ===== 6. type 过滤 =====
  const tGz = await kb(tk, '?type=' + encodeURIComponent('故障'));
  const gzIds = (tGz.body.rows || []).map((r) => String(r.id));
  assert(tGz.status === 200 && tGz.body.total === 1 && gzIds.includes(String(a1.body.id)),
    `type=故障 → 仅 A1（A5 已删除不参与）`);
  const tXq = await kb(tk, '?type=' + encodeURIComponent('需求'));
  const xqIds = (tXq.body.rows || []).map((r) => String(r.id));
  assert(tXq.status === 200 && tXq.body.total === 1 && xqIds.includes(String(a4.body.id)),
    `type=需求 → 仅 A4`);
  const tZx = await kb(tk, '?type=' + encodeURIComponent('咨询'));
  assert(tZx.status === 200 && tZx.body.total === 0, `type=咨询 → 0 条（A2/A3 被收录口径挡住）`);

  // ===== 7. 响应形状与分页 =====
  const shape = await kb(tk);
  assert(
    shape.body && Array.isArray(shape.body.rows) &&
    typeof shape.body.total === 'number' && shape.body.page === 1 && shape.body.pageSize === 20,
    `响应形状 { rows, total, page, pageSize }（实测 page=${shape.body.page} pageSize=${shape.body.pageSize}）`
  );
  const p1 = await kb(tk, '?pageSize=1&page=1');
  assert(p1.body.rows.length === 1 && p1.body.total === 2 && p1.body.page === 1 && p1.body.pageSize === 1,
    `分页 page=1&pageSize=1 → rows 1 条、total=2`);
  const p2 = await kb(tk, '?pageSize=1&page=2');
  assert(p2.body.rows.length === 1 && String(p2.body.rows[0].id) !== String(p1.body.rows[0].id),
    `分页 page=2 → 另一条（翻页不重复）`);
  const clamp = await kb(tk, '?pageSize=999');
  assert(clamp.status === 200 && clamp.body.pageSize === 100, `pageSize 超上限被钳到 100（实测 ${clamp.body.pageSize}）`);

  // ===== 8. 未登录 401 =====
  const noAuth = await kb(null);
  assert(noAuth.status === 401, `未登录访问 KB → 401（实测 ${noAuth.status}）`);

  // ===== 9. 排序：默认 updated_at desc（先造的 A1 后来改过 → 排前面）=====
  await sleep(20);
  const upd = await J(`${BASE}/api/problems/${a1.body.id}`, tk, {
    method: 'PUT', body: JSON.stringify({ resolution: '重启打印服务后恢复正常；补充：需每日巡检打印队列' }),
  });
  assert(upd.status === 200, `后改 A1 的处理说明（updated_at 刷新）`);
  const sorted = await kb(tk);
  assert(
    sorted.body.total === 2 && String(sorted.body.rows[0].id) === String(a1.body.id),
    `默认排序 updated_at desc：后改的 A1 排在 A4 之前`
  );
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
