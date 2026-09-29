// v1.18.22 端到端：**问题登记「引用到聊天」—— 发送带 ref 的聊天消息**。
//
// 钉住的规则（与 routes/chat.js 的 POST /conversations/:id/messages、chat/*Store 一一对应）：
//   1. 仅认 req.body.ref.id（数字/数字字符串）；其余字段（title/status 等）一律忽略，
//      快照 { id, title, status } 由后端从问题库读取（不信任客户端伪造值）；
//   2. 引用指向「不存在」或「其它机构」问题 → 统一 400「引用的问题不存在」（不泄漏跨机构存在性）；
//   3. 空消息判定：body、attachments、ref 三者皆空才 400「消息内容不能为空」；
//   4. 带引用时留言 body ≤500 字（普通消息 ≤4000）；超长 → 400；
//   5. 存储出口：mapMsg 输出含 ref（对象）；recalled 消息在出口屏蔽 ref（墓碑，ref=null）；
//   6. 会话列表最后一条消息预览：引用消息显示「[问题引用] + 标题」，recalled 仍为空；
//   7. AI 会话的 assistant 回复不带 ref（维持现状；ref 只作用于用户消息）。
//
// 运行：cd backend && node test/chat-ref.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3780 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `chatref-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `chatref-uploads-${stamp}`);

// 预置两个问题：org1 的「真实问题」（可被当前用户引用），org2 的「外机构问题」（应被拒）。
// 这样无需建真实账号/机构即可稳定复现「跨机构引用 → 400」语义。
const seedIssues = [
  {
    id: 1, org_id: 1, title: '真实问题标题', department: '信息科', reporter: '张三', contact: '123',
    type: '故障', severity: '高', status: '处理中',
    description: 'seed', handler: '李四', registrar: 'admin', softwareSystem: 'HIS', resolution: '',
    attachments: [], createdBy: 'admin', audit_status: '待审核', audit_reason: '', audit_by: '', audit_at: null,
    satisfaction: '', feedback: '', rated_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), resolved_at: null, deleted_at: null,
  },
  {
    id: 2, org_id: 2, title: '外机构问题', department: '其它科', reporter: '王五', contact: '456',
    type: '需求', severity: '中', status: '已解决',
    description: 'seed-other-org', handler: '赵六', registrar: 'admin', softwareSystem: 'LIS', resolution: '',
    attachments: [], createdBy: 'admin', audit_status: '待审核', audit_reason: '', audit_by: '', audit_at: null,
    satisfaction: '', feedback: '', rated_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), resolved_at: null, deleted_at: null,
  },
];
fs.writeFileSync(files.DEV_DB_PATH, JSON.stringify(seedIssues, null, 2), 'utf8');

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'chat-ref-test-secret',
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
const login = async (username, password) => {
  const r = await J(`${BASE}/api/auth/login`, null, { method: 'POST', body: JSON.stringify({ username, password }) });
  return r.body && r.body.token ? r.body.token : null;
};
const sendWithRef = (token, convId, body, ref) =>
  J(`${BASE}/api/chat/conversations/${convId}/messages`, token, {
    method: 'POST', body: JSON.stringify({ body: body || '', ...(ref != null ? { ref } : {}) }),
  });
const listMsgs = (token, convId) => J(`${BASE}/api/chat/conversations/${convId}/messages`, token);
const listConvs = (token) => J(`${BASE}/api/chat/conversations`, token);
const recall = (token, convId, mid) =>
  J(`${BASE}/api/chat/conversations/${convId}/messages/${mid}/recall`, token, { method: 'POST' });

async function main() {
  await waitReady();

  // ===== 0. 登录 + 建两个 reporter 账号（默认含 chat.use，且归属默认机构 org1）=====
  const admin = await login('admin', 'admin123');
  assert(!!admin, '管理员登录成功');
  for (const [u, n] of [['citer', '引用人'], ['peer', '同事']]) {
    const mk = await J(`${BASE}/api/users`, admin, {
      method: 'POST', body: JSON.stringify({ username: u, name: n, password: u + '123', role: 'reporter' }),
    });
    assert(mk.status === 201, `创建账号 ${u}（HTTP ${mk.status}）`);
  }
  const tk = await login('citer', 'citer123');
  assert(!!tk, 'citer 登录成功');

  // ===== 1. 建一个同事会话（citer + peer，均属 org1）→ 作为引用落点 =====
  const convU = await J(`${BASE}/api/chat/conversations`, tk, {
    method: 'POST', body: JSON.stringify({ type: 'user', members: ['peer'] }),
  });
  assert(convU.status === 201, `citer 建与 peer 的同事会话（id=${convU.body.id}）`);
  const uId = convU.body.id;

  // ===== 2. 引用真实问题：快照 title/status 来自后端，客户端伪造值一律无效 =====
  const forged = await sendWithRef(tk, uId, '', { id: 1, title: '伪造标题XXX', status: '已关闭', extra: 'hacked' });
  assert(forged.status === 200 && forged.body.user, '带引用发送成功（200）');
  assert(forged.body.user.ref && forged.body.user.ref.id === 1, '返回 ref.id === 1');
  assert(forged.body.user.ref.title === '真实问题标题', 'ref.title 取自问题库（非客户端伪造「伪造标题XXX」）');
  assert(forged.body.user.ref.status === '处理中', 'ref.status 取自问题库（非客户端伪造「已关闭」）');
  const refKeys = Object.keys(forged.body.user.ref).sort().join(',');
  assert(refKeys === 'id,status,title', `ref 仅含快照字段 {id,title,status}（实测 ${refKeys}）`);
  const snapId = forged.body.user.id;

  // ===== 3. 仅引用、无正文、无附件 → 正常落库 =====
  const refOnly = await sendWithRef(tk, uId, '', { id: 1 });
  assert(refOnly.status === 200 && refOnly.body.user, '仅引用（无正文）发送成功（200）');
  assert(refOnly.body.user.ref && refOnly.body.user.ref.id === 1, '仅引用消息的 ref.id === 1');
  const refOnlyId = refOnly.body.user.id;

  // 回读验证：存储出口的 ref 确实被完整写出
  const afterSend = await listMsgs(tk, uId);
  const snapRaw = (afterSend.body || []).find((m) => m.id === snapId);
  const refOnlyRaw = (afterSend.body || []).find((m) => m.id === refOnlyId);
  assert(!!snapRaw && snapRaw.ref && snapRaw.ref.title === '真实问题标题' && snapRaw.ref.status === '处理中',
    'GET messages：引用消息的 ref 完整回读（title/status 与库一致）');
  assert(!!refOnlyRaw && refOnlyRaw.ref && refOnlyRaw.ref.id === 1, 'GET messages：仅引用消息的 ref 回读正确');

  // ===== 4. 引用不存在的问题 → 400 =====
  const noSuch = await sendWithRef(tk, uId, '', { id: 99999 });
  assert(noSuch.status === 400, `引用不存在的问题 → 400（实测 ${noSuch.status}）`);
  assert(noSuch.body && noSuch.body.error === '引用的问题不存在', `错误文案一致（实测 ${noSuch.body && noSuch.body.error}）`);

  // ===== 5. 引用其它机构（org2）的问题 → 同样 400 + 同文案（不泄漏跨机构存在性）=====
  const crossOrg = await sendWithRef(tk, uId, '', { id: 2 });
  assert(crossOrg.status === 400, `引用其它机构问题 → 400（实测 ${crossOrg.status}）`);
  assert(crossOrg.body && crossOrg.body.error === '引用的问题不存在',
    `跨机构与「不存在」同文案（实测 ${crossOrg.body && crossOrg.body.error}）`);

  // ===== 6. 带引用但正文超 500 字 → 400 =====
  const tooLong = await sendWithRef(tk, uId, 'x'.repeat(501), { id: 1 });
  assert(tooLong.status === 400, `带引用正文超 500 字 → 400（实测 ${tooLong.status}）`);
  assert(tooLong.body && tooLong.body.error === '引用留言过长（≤500 字）', `错误文案一致（实测 ${tooLong.body && tooLong.body.error}）`);

  // ===== 7. body / attachments / ref 全空 → 400 =====
  const empty = await sendWithRef(tk, uId, '', null);
  assert(empty.status === 400, `三者皆空 → 400（实测 ${empty.status}）`);
  assert(empty.body && empty.body.error === '消息内容不能为空', `错误文案一致（实测 ${empty.body && empty.body.error}）`);

  // ===== 8. 会话列表最后一条消息预览 = [问题引用] + 标题 =====
  const convs = await listConvs(tk);
  const convRow = (convs.body || []).find((c) => c.id === uId);
  assert(!!convRow && convRow.lastMessage === '[问题引用] 真实问题标题',
    `会话预览为「[问题引用] 真实问题标题」（实测 ${convRow && JSON.stringify(convRow.lastMessage)}）`);

  // ===== 9. 撤回该引用消息 → 出口屏蔽 ref（墓碑）=====
  const rec = await recall(tk, uId, refOnlyId); // refOnlyId 是最后一条，撤回最末消息
  assert(rec.status === 200, `撤回引用消息 → 200（实测 ${rec.status}）`);
  const afterRecall = await listMsgs(tk, uId);
  const tomb = (afterRecall.body || []).find((m) => m.id === refOnlyId);
  assert(!!tomb && tomb.recalled === true && tomb.body === '' && tomb.attachments.length === 0,
    '撤回后出口屏蔽正文与附件（recalled=true / 正文为空 / attachments=[]）');
  assert(tomb.ref === null, '撤回后出口屏蔽 ref（ref=null，墓碑逻辑覆盖引用）');
  const convs2 = await listConvs(tk);
  const convRow2 = (convs2.body || []).find((c) => c.id === uId);
  assert(!!convRow2 && convRow2.lastMessage === '', `撤回后会话预览为空（recalled 仍空，实测 ${JSON.stringify(convRow2 && convRow2.lastMessage)}）`);

  // ===== 10. AI 会话：assistant 回复不带 ref（ref 仅作用于用户消息）=====
  const ai = await J(`${BASE}/api/chat/ai`, tk);
  assert(ai.status === 200 && ai.body.type === 'ai', `citer 获得 AI 会话（id=${ai.body.id}）`);
  const aiId = ai.body.id;
  const aiSent = await sendWithRef(tk, aiId, 'AI 里引用一下', { id: 1 });
  assert(aiSent.status === 200 && aiSent.body.user && aiSent.body.assistant, 'AI 会话带引用发送并拿到 assistant 回复');
  assert(aiSent.body.user.ref && aiSent.body.user.ref.id === 1, 'AI 会话中用户消息仍带快照 ref.id===1');
  assert(aiSent.body.assistant.ref == null, 'AI 会话的 assistant 回复不带 ref（维持现状）');
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
