// v1.2 自测脚本：问题审核 + 中文化 + 回归（dev 驱动，临时目录 + 临时端口 3111）
// 用法：node selftest_v12.mjs  （结束后自动清理临时目录）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/AI/海盐县人民医院/信息科登记问题程序';
const TMP = path.join(ROOT, '.selftest-v12');
const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}/api`;
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' | ' + extra : ''}`); console.log(`  FAIL ${name} ${extra}`); }
}

// ---- 临时目录 + 遗留数据（无审核字段的老记录）----
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const legacy = [
  { id: 1, title: '历史问题A', department: '内科', reporter: '王五', contact: '', type: '故障', severity: '中', status: '待处理', description: '老系统崩溃', handler: '', registrar: '查无此人', softwareSystem: 'HIS', resolution: '', attachments: [], createdBy: '', satisfaction: '', feedback: '', rated_at: null, created_at: '2025-01-01T08:00:00.000Z', updated_at: '2025-01-01T08:00:00.000Z', resolved_at: null },
  { id: 2, title: '历史问题B', department: '外科', reporter: '赵六', contact: '', type: '需求', severity: '低', status: '待处理', description: '希望加个导出功能', handler: '', registrar: '报告员', softwareSystem: 'LIS', resolution: '', attachments: [], createdBy: '', satisfaction: '', feedback: '', rated_at: null, created_at: '2025-01-02T08:00:00.000Z', updated_at: '2025-01-02T08:00:00.000Z', resolved_at: null },
];
fs.writeFileSync(path.join(TMP, 'issues.json'), JSON.stringify(legacy, null, 2), 'utf8');

// ---- 启动被测服务（临时端口 + 临时数据目录，绝不触碰 backend/data 与 3000）----
const server = spawn(NODE, ['src/index.js'], {
  cwd: path.join(ROOT, 'backend'),
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_DRIVER: 'dev',
    DEV_DB_PATH: path.join(TMP, 'issues.json'),
    DEV_USERS_PATH: path.join(TMP, 'users.json'),
    AUDIT_DEV_PATH: path.join(TMP, 'audit.json'),
    SETTINGS_DEV_PATH: path.join(TMP, 'settings.json'),
    NOTIFICATIONS_DEV_PATH: path.join(TMP, 'notifications.json'),
    SCHEDULE_DEV_PATH: path.join(TMP, 'schedules.json'),
    UPLOADS_DIR: path.join(TMP, 'uploads'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function req(method, url, { token, body, rawBody } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (rawBody !== undefined) { headers['Content-Type'] = 'application/json'; payload = rawBody; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, data, text };
}

async function main() {
  console.log('== 启动与登录 ==');
  check('S01 服务健康检查', await waitHealth());

  const loginAdmin = await req('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
  check('S02 管理员登录', loginAdmin.status === 200 && !!loginAdmin.data?.token, `status=${loginAdmin.status}`);
  const admin = loginAdmin.data?.token;

  const meAdmin = await req('GET', '/auth/me', { token: admin });
  check('S03 管理员身份 me', meAdmin.status === 200 && meAdmin.data?.user?.username === 'admin');

  const mkReporter = await req('POST', '/users', { token: admin, body: { username: 'reporter1', password: 'rep123456', role: 'reporter', name: '报告员' } });
  check('S04 新增登记员用户', mkReporter.status === 200 || mkReporter.status === 201, `status=${mkReporter.status} ${mkReporter.text}`);

  const loginRep = await req('POST', '/auth/login', { body: { username: 'reporter1', password: 'rep123456' } });
  check('S05 登记员登录', loginRep.status === 200 && !!loginRep.data?.token);
  const rep = loginRep.data?.token;

  console.log('== 中文化（401/403/404/非法JSON） ==');
  const noToken = await req('GET', '/problems');
  check('S06 未登录 401 中文提示', noToken.status === 401 && (noToken.data?.error || '').includes('未登录或登录已失效，请重新登录'), JSON.stringify(noToken.data));
  const badJson = await req('POST', '/problems', { token: admin, rawBody: '{"bad' });
  check('S07 非法 JSON 400 且中文', badJson.status === 400 && /^[\u4e00-\u9fa5]/.test(badJson.data?.error || ''), JSON.stringify(badJson.data));
  const unknownApi = await req('GET', '/definitely-not-exist', { token: admin });
  check('S08 未知接口 404 中文', unknownApi.status === 404 && unknownApi.data?.error === '接口不存在', JSON.stringify(unknownApi.data));

  console.log('== 遗留数据兼容（老记录无审核字段） ==');
  const legacyGet = await req('GET', '/problems/1', { token: admin });
  check('S09 遗留记录读取为待审核', legacyGet.status === 200 && legacyGet.data?.audit_status === '待审核' && legacyGet.data?.audit_reason === '' && legacyGet.data?.audit_by === '' && legacyGet.data?.audit_at === null, JSON.stringify(legacyGet.data));

  console.log('== 登记与权限 ==');
  const created = await req('POST', '/problems', { token: rep, body: { title: '新登记的问题', department: '内科', reporter: '王五', type: '故障', severity: '高', status: '待处理', description: '无法打开工作站' } });
  const id3 = created.data?.id;
  check('S10 登记员登记问题', created.status === 201 && !!id3 && created.data?.audit_status === '待审核', `status=${created.status}`);
  check('S11 createdBy 注入登记账号', created.data?.createdBy === 'reporter1');

  const repAudit = await req('POST', `/problems/${id3}/audit`, { token: rep, body: { result: 'approve' } });
  check('S12 无 issue.audit 权限 403 中文', repAudit.status === 403 && repAudit.data?.error === '没有执行此操作的权限', JSON.stringify(repAudit.data));

  const repUsers = await req('GET', '/users', { token: rep });
  check('S13 登记员访问用户管理 403', repUsers.status === 403 && repUsers.data?.error === '没有执行此操作的权限');

  console.log('== 审核主流程 ==');
  const approveNoReason = await req('POST', `/problems/${id3}/audit`, { token: admin, body: { result: 'approve' } });
  check('S14 通过无需原因 200', approveNoReason.status === 200 && approveNoReason.data?.audit_status === '已通过', JSON.stringify(approveNoReason.data));

  const afterApprove = await req('GET', `/problems/${id3}`, { token: admin });
  check('S15 审核结果可查询', afterApprove.data?.audit_status === '已通过' && !!afterApprove.data?.audit_at && !!afterApprove.data?.audit_by);

  const filterPassed = await req('GET', '/problems?auditStatus=' + encodeURIComponent('已通过'), { token: admin });
  check('S16 auditStatus=已通过 过滤', filterPassed.status === 200 && filterPassed.data?.rows?.some((r) => r.id === id3) && !filterPassed.data?.rows?.some((r) => r.id === 1));
  const filterPending = await req('GET', '/problems?auditStatus=' + encodeURIComponent('待审核'), { token: admin });
  check('S17 auditStatus=待审核 过滤', filterPending.data?.rows?.some((r) => r.id === 1) && filterPending.data?.rows?.some((r) => r.id === 2) && !filterPending.data?.rows?.some((r) => r.id === id3));

  const rejectEmpty = await req('POST', '/problems/2/audit', { token: admin, body: { result: 'reject', reason: '   ' } });
  check('S18 不通过缺原因 400', rejectEmpty.status === 400 && rejectEmpty.data?.error === '请填写不通过原因', JSON.stringify(rejectEmpty.data));

  const rejectBadResult = await req('POST', '/problems/2/audit', { token: admin, body: { result: 'maybe' } });
  check('S19 非法 result 400', rejectBadResult.status === 400 && (rejectBadResult.data?.error || '').includes('审核结果不合法'));

  const rejectOk = await req('POST', '/problems/2/audit', { token: admin, body: { result: 'reject', reason: '描述不够详细' } });
  check('S20 不通过填写原因 200', rejectOk.status === 200 && rejectOk.data?.audit_status === '不通过' && rejectOk.data?.audit_reason === '描述不够详细' && rejectOk.data?.audit_by === '系统管理员' && !!rejectOk.data?.audit_at, JSON.stringify(rejectOk.data));

  const afterReject = await req('GET', '/problems/2', { token: admin });
  check('S21 不通过结果可查询', afterReject.data?.audit_status === '不通过' && afterReject.data?.audit_reason === '描述不够详细');

  const reject404 = await req('POST', '/problems/99999/audit', { token: admin, body: { result: 'approve' } });
  check('S22 不存在问题 404', reject404.status === 404 && reject404.data?.error === '问题不存在', JSON.stringify(reject404.data));

  console.log('== 重复审核覆盖 ==');
  const overwrite = await req('POST', `/problems/${id3}/audit`, { token: admin, body: { result: 'reject', reason: '复核不通过' } });
  check('S23 重复审核覆盖(改不通过)', overwrite.status === 200 && overwrite.data?.audit_status === '不通过' && overwrite.data?.audit_reason === '复核不通过');
  const overwrite2 = await req('POST', `/problems/${id3}/audit`, { token: admin, body: { result: 'approve' } });
  check('S24 重复审核覆盖(改回通过)', overwrite2.status === 200 && overwrite2.data?.audit_status === '已通过' && overwrite2.data?.audit_reason === '');

  console.log('== 审核通知登记人 ==');
  // createdBy 路径：id3 由 reporter1 登记
  const notifCreatedBy = await req('GET', '/notifications', { token: rep });
  const items = notifCreatedBy.data?.rows || notifCreatedBy.data?.items || notifCreatedBy.data || [];
  const arr = Array.isArray(items) ? items : (items.rows || []);
  check('S25 通知登记人(createdBy 路径)', arr.some((n) => (n.title || '').includes('问题审核')), JSON.stringify(arr).slice(0, 200));
  // 登记人花名册反查路径：id2 无 createdBy、registrar=报告员
  const notifRegistrar = await req('GET', '/notifications', { token: rep });
  const arr2 = (notifRegistrar.data?.rows || notifRegistrar.data || []);
  check('S26 通知登记人(registrar 反查路径)', (Array.isArray(arr2) ? arr2 : []).some((n) => (n.title || '').includes('问题审核不通过')), JSON.stringify(arr2).slice(0, 200));
  // registrar 查无此人：id1 审核成功且不报错
  const approveId1 = await req('POST', '/problems/1/audit', { token: admin, body: { result: 'approve' } });
  check('S27 登记人无法匹配时静默跳过', approveId1.status === 200 && approveId1.data?.audit_status === '已通过');

  console.log('== 编辑忽略审核字段 ==');
  const hackEdit = await req('PUT', `/problems/${id3}`, { token: admin, body: { title: '新登记的问题-改', audit_status: '不通过', audit_reason: '越权改审核' } });
  check('S28 编辑不可篡改审核状态', hackEdit.status === 200 && hackEdit.data?.audit_status === '已通过' && hackEdit.data?.audit_reason === '' && hackEdit.data?.title === '新登记的问题-改', JSON.stringify(hackEdit.data));

  console.log('== 导出 ==');
  const expCsv = await req('GET', '/problems/export?format=csv', { token: admin });
  const expText = expCsv.text || '';
  check('S29 问题导出含审核4列', expCsv.status === 200 && expText.includes('审核状态') && expText.includes('审核意见') && expText.includes('审核人') && expText.includes('审核时间'), expText.slice(0, 120));
  check('S30 问题导出含中文审核值', expText.includes('已通过') && expText.includes('不通过'));
  const auditCsv = await req('GET', '/audit/export?format=csv', { token: admin });
  const auditText = auditCsv.text || '';
  check('S31 日志导出操作列全中文', auditCsv.status === 200 && auditText.includes('审核通过') && auditText.includes('审核不通过') && !auditText.includes('APPROVE_ISSUE') && !auditText.includes('REJECT_ISSUE'), auditText.slice(0, 200));
  const expXlsx = await fetch(`${BASE}/problems/export?format=xlsx`, { headers: { Authorization: 'Bearer ' + admin } });
  const xbuf = Buffer.from(await expXlsx.arrayBuffer());
  check('S32 问题导出 xlsx 正常', expXlsx.status === 200 && xbuf.length > 500);

  console.log('== 回归：原有核心功能 ==');
  const upd = await req('PUT', `/problems/1`, { token: admin, body: { status: '处理中', handler: '李工' } });
  check('S33 编辑问题', upd.status === 200 && upd.data?.status === '处理中' && upd.data?.handler === '李工');
  const stats = await req('GET', '/problems/stats', { token: admin });
  check('S34 stats 接口', stats.status === 200 && typeof stats.data?.total === 'number');
  const dash = await req('GET', '/problems/dashboard', { token: admin });
  check('S35 dashboard 接口', dash.status === 200 && !!dash.data?.byStatus);
  const trend = await req('GET', '/problems/trend', { token: admin });
  check('S36 trend 接口', trend.status === 200 && Array.isArray(trend.data?.byMonth));

  const bulk = await req('POST', '/problems/bulk/status', { token: admin, body: { ids: [1, 2], status: '已解决' } });
  check('S37 批量改状态', bulk.status === 200 && bulk.data?.ok === true && bulk.data?.updated === 2, JSON.stringify(bulk.data));
  const bulkBack = await req('POST', '/problems/bulk/status', { token: admin, body: { ids: [1, 2], status: '待处理' } });
  check('S38 批量改回', bulkBack.status === 200);

  const rate = await req('POST', `/problems/${id3}/satisfaction`, { token: rep, body: { satisfaction: '满意', feedback: '处理很及时' } });
  check('S39 回访打分(登记人本人)', rate.status === 200 && rate.data?.satisfaction === '满意', JSON.stringify(rate.data));

  const schedAdd = await req('POST', '/schedules', { token: admin, body: { date: '2025-01-06', handlerName: '李工', note: '白班' } });
  check('S40 新增排班', schedAdd.status === 200 || schedAdd.status === 201, `status=${schedAdd.status} ${schedAdd.text}`);
  const schedList = await req('GET', '/schedules?from=2025-01-06&to=2025-01-06', { token: rep });
  const schedRows = schedList.data?.rows || schedList.data || [];
  check('S41 查询排班(全员可看)', schedList.status === 200 && (Array.isArray(schedRows) ? schedRows : []).some((s) => s.handler_name === '李工' || s.handlerName === '李工'), JSON.stringify(schedRows).slice(0, 200));
  const schedList2 = await req('GET', '/schedules?from=2025-01-06&to=2025-01-06', { token: rep });
  const rid = ((schedList2.data?.rows || schedList2.data || [])[0] || {}).id;
  const schedDel = rid ? await req('DELETE', `/schedules/${rid}`, { token: admin }) : { status: 0 };
  check('S42 删除排班', schedDel.status === 200);

  const sendNotif = await req('POST', '/notifications', { token: admin, body: { title: '系统维护通知', body: '今晚 22:00 停机维护', to: ['reporter1'] } });
  check('S43 发送通知', sendNotif.status === 200, `status=${sendNotif.status} ${sendNotif.text}`);
  const repNotif = await req('GET', '/notifications', { token: rep });
  const repArr = repNotif.data?.rows || repNotif.data || [];
  check('S44 登记员收到通知', (Array.isArray(repArr) ? repArr : []).some((n) => (n.title || '').includes('系统维护通知')));

  const settingsNoAuth = await req('PUT', '/settings', { body: { appName: 'x' } });
  check('S45 未登录修改设置被拒(401 中文)', settingsNoAuth.status === 401 && (settingsNoAuth.data?.error || '').includes('未登录或登录已失效'), JSON.stringify(settingsNoAuth.data));
  const cfg = await req('GET', '/config');
  const cfgStr = JSON.stringify(cfg.data) || '';
  check('S46 config 权限表含 issue.audit 动作', cfg.status === 200 && cfgStr.includes('issue.audit') && cfgStr.includes('"schedule.manage"'), `status=${cfg.status} len=${cfgStr.length}`);
  const usersList = await req('GET', '/users', { token: admin });
  check('S47 用户列表', usersList.status === 200 && (usersList.data || []).some((u) => u.username === 'reporter1'));

  const delIssue = await req('DELETE', `/problems/${id3}`, { token: admin });
  check('S48 删除问题', delIssue.status === 200 && delIssue.data?.ok === true);
  const afterDel = await req('GET', `/problems/${id3}`, { token: admin });
  check('S49 删除后 404', afterDel.status === 404);

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  -', f); }
  if (fail > 0) { console.log('\n--- 服务日志（末尾）---'); console.log(serverLog.slice(-2000)); }
}

main()
  .catch((e) => { fail++; console.error('脚本异常：', e); console.log('服务日志：', serverLog.slice(-3000)); })
  .finally(() => {
    try { server.kill(); } catch { /* ignore */ }
    setTimeout(() => {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
      process.exit(fail > 0 ? 1 : 0);
    }, 500);
  });
