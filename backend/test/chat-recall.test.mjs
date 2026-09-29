// v1.18.14 端到端：**聊天消息撤回（recall）+ 左侧会话列表移除（AI=删除 / 同事=退出）**。
//
// 钉住的规则（与 routes/chat.js 两个新端点、chat/*Store 新方法一一对应）：
//   1. 权限链：两个新端点只需 authenticate（撤回/退出是个人内容操作，与「看聊天只需登录」一致）；
//   2. 撤回：会话成员可撤回会话内任何消息（v1.18.33 放宽：含对方发送的）；
//      AI 会话经守卫收敛为仅属主可访问；会话不存在/不可见一律 404（不泄漏存在性）；消息不存在 404；重复撤回幂等 200；
//   3. 墓碑式占位：撤回后所有读者（含发送者）GET messages 只看到 recalled=true、body=''、
//      attachments=[] —— 正文与附件在存储出口即屏蔽，任何角色都拿不到原文；
//   4. DELETE 会话：AI 会话仅属主可删（删除会话+全部消息，下次发消息自动重建）；
//      同事会话=退出（退出者不可见，其他成员不受影响）；最后一名成员退出时会话与消息整体删除。
//
// 运行：cd backend && node test/chat-recall.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3720 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `chatrecall-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
};
const uploads = path.join(os.tmpdir(), `chatrecall-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'chat-recall-test-secret',
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
const sendMsg = (token, convId, body) =>
  J(`${BASE}/api/chat/conversations/${convId}/messages`, token, { method: 'POST', body: JSON.stringify({ body }) });
const listMsgs = (token, convId) => J(`${BASE}/api/chat/conversations/${convId}/messages`, token);
const recall = (token, convId, mid) =>
  J(`${BASE}/api/chat/conversations/${convId}/messages/${mid}/recall`, token, { method: 'POST' });
const removeConv = (token, convId) => J(`${BASE}/api/chat/conversations/${convId}`, token, { method: 'DELETE' });
const listConvs = (token) => J(`${BASE}/api/chat/conversations`, token);

const SECRET = '机密消息不要外传';

async function main() {
  await waitReady();

  // ===== 0. 登录 + 建三个普通账号（reporter 默认含 chat.use）=====
  const admin = await login('admin', 'admin123');
  assert(!!admin, '管理员登录成功');
  for (const [u, n] of [['alice', '甲'], ['bob', '乙'], ['carol', '丙']]) {
    const mk = await J(`${BASE}/api/users`, admin, {
      method: 'POST', body: JSON.stringify({ username: u, name: n, password: u + '123', role: 'reporter' }),
    });
    assert(mk.status === 201, `创建账号 ${u}（HTTP ${mk.status}）`);
  }
  const tkA = await login('alice', 'alice123');
  const tkB = await login('bob', 'bob123');
  const tkC = await login('carol', 'carol123');
  assert(!!tkA && !!tkB && !!tkC, 'alice / bob / carol 登录成功');

  // ===== 1. 未登录调两个新端点 → 401 =====
  const anon1 = await recall(null, 1, 1);
  const anon2 = await removeConv(null, 1);
  assert(anon1.status === 401 && anon2.status === 401,
    `未登录调 recall / DELETE → 401（${anon1.status}/${anon2.status}）`);

  // ===== 2. AI 会话：属主撤回 assistant 回复 =====
  const ai = await J(`${BASE}/api/chat/ai`, tkA);
  assert(ai.status === 200 && ai.body.type === 'ai', `alice 获得 AI 会话（id=${ai.body.id}）`);
  const aiId = ai.body.id;
  const sent = await sendMsg(tkA, aiId, '你好 AI');
  assert(sent.status === 200 && sent.body.assistant, 'alice 发消息并拿到 assistant 回复');
  const asstId = sent.body.assistant.id;
  const rec1 = await recall(tkA, aiId, asstId);
  assert(rec1.status === 200 && rec1.body.ok, `AI 会话属主撤回 assistant 回复 → 200（${rec1.status}）`);
  const after1 = await listMsgs(tkA, aiId);
  const tomb = (after1.body || []).find((m) => m.id === asstId);
  assert(!!tomb && tomb.recalled === true && tomb.body === '' && Array.isArray(tomb.attachments) && tomb.attachments.length === 0,
    `撤回后属主只看到墓碑占位（recalled=true / body='' / attachments=[]，实测 ${JSON.stringify(tomb)})`);
  const replyText = sent.body.assistant.body || '';
  assert(!JSON.stringify(after1.body).includes(replyText), '撤回后的消息列表不含 assistant 回复正文');

  // 非属主：既有消息读接口守卫保持 403（api.test.mjs 钉死的行为）；新撤回端点收敛为 404（不泄漏存在性）
  const bobView = await listMsgs(tkB, aiId);
  const bobRecall = await recall(tkB, aiId, asstId);
  assert(bobView.status === 403 && bobRecall.status === 404 && /会话不存在/.test(bobRecall.body.error || ''),
    `非属主 GET（既有 403）/ 撤回（新端点 404）他人 AI 会话（${bobView.status}/${bobRecall.status}：${bobRecall.body && bobRecall.body.error}）`);

  // ===== 3. 同事会话：撤回自己的消息 / 撤回对方的消息（v1.18.33 放宽为成员可撤任何消息） =====
  const convU = await J(`${BASE}/api/chat/conversations`, tkA, {
    method: 'POST', body: JSON.stringify({ type: 'user', members: ['bob'] }),
  });
  assert(convU.status === 201, `alice 建与 bob 的同事会话（id=${convU.body.id}）`);
  const uId = convU.body.id;
  const m1 = await sendMsg(tkA, uId, SECRET);
  const m2 = await sendMsg(tkB, uId, '收到');
  assert(m1.status === 200 && m2.status === 200, '双方各发一条消息');
  const m1id = m1.body.user.id;
  const m2id = m2.body.user.id;

  // v1.18.33：bob 撤回 alice 发的消息（他人消息）→ 200，接口层正文屏蔽为墓碑
  const recallOther = await recall(tkB, uId, m1id);
  assert(recallOther.status === 200, `成员撤回对方消息 → 200（v1.18.33，实测 ${recallOther.status}：${recallOther.body && recallOther.body.error}）`);
  const forA1 = await listMsgs(tkA, uId);
  const tombA = (forA1.body || []).find((m) => m.id === m1id);
  assert(!!tombA && tombA.recalled === true && tombA.body === '' && tombA.attachments.length === 0,
    `发送者（alice）视角同样是墓碑占位（实测 ${JSON.stringify(tombA)}）`);
  assert(!JSON.stringify(forA1.body).includes(SECRET), '撤回他人消息后正文同样从列表 JSON 消失（无泄露）');

  // 后发的消息再由 alice 撤回（发送者本人），并验证重复撤回幂等
  const ok1 = await recall(tkA, uId, m2id);
  assert(ok1.status === 200, `发送者本人撤回对方视角消息（m2 由 bob 发、alice 撤）→ 200（${ok1.status}）`);
  const ok2 = await recall(tkA, uId, m2id);
  assert(ok2.status === 200, `重复撤回 → 200 幂等（${ok2.status}）`);

  // ===== 4. 边界：非成员 404 / 消息不存在 404 =====
  const cRecall = await recall(tkC, uId, m2id);
  const cDelete = await removeConv(tkC, uId);
  assert(cRecall.status === 404 && cDelete.status === 404,
    `非成员撤回 / 删除同事会话 → 404（${cRecall.status}/${cDelete.status}）`);
  const noMsg = await recall(tkA, uId, 999999);
  assert(noMsg.status === 404 && /消息不存在/.test(noMsg.body.error || ''),
    `撤回不存在的消息 → 404「消息不存在」（实测 ${noMsg.status}：${noMsg.body && noMsg.body.error}）`);

  // ===== 5. DELETE AI 会话：属主删除 + 自动重建 =====
  const delAi = await removeConv(tkA, aiId);
  assert(delAi.status === 200 && delAi.body.removed === 'all',
    `属主删除 AI 会话 → 200 removed=all（实测 ${delAi.status}/${delAi.body && JSON.stringify(delAi.body)}）`);
  const convsA = await listConvs(tkA);
  assert(!(convsA.body || []).some((c) => c.id === aiId), '删除后 AI 会话从列表消失');
  const goneMsgs = await listMsgs(tkA, aiId);
  assert(goneMsgs.status === 404, `删除后 GET 原会话消息 → 404（${goneMsgs.status}）`);
  const ai2 = await J(`${BASE}/api/chat/ai`, tkA);
  assert(ai2.status === 200 && ai2.body.id !== aiId, `再取 AI 会话自动新建（新 id=${ai2.body.id} ≠ 旧 id=${aiId}）`);
  const resend = await sendMsg(tkA, ai2.body.id, '重建后第一条');
  assert(resend.status === 200 && resend.body.assistant, '新 AI 会话发消息正常（assistant 照常回复）');

  // ===== 6. DELETE 同事会话：bob 退出，alice 不受影响 =====
  const leave = await removeConv(tkB, uId);
  assert(leave.status === 200 && leave.body.removed === 'self',
    `bob 退出同事会话 → 200 removed=self（实测 ${leave.status}/${leave.body && JSON.stringify(leave.body)}）`);
  const convsB = await listConvs(tkB);
  assert(!(convsB.body || []).some((c) => c.id === uId), '退出者会话列表中消失');
  const bobAfter = await listMsgs(tkB, uId);
  assert(bobAfter.status === 403, `退出者 re-GET messages → 403（既有守卫行为，实测 ${bobAfter.status}）`);
  const convsA2 = await listConvs(tkA);
  assert((convsA2.body || []).some((c) => c.id === uId), '另一成员（alice）仍能看到该会话');
  const aliceMsgs = await listMsgs(tkA, uId);
  const m2still = (aliceMsgs.body || []).find((m) => m.id === m2id);
  assert(aliceMsgs.status === 200 && m2still && m2still.recalled === true,
    '另一成员的消息仍在（m2 此前已被撤回，保持墓碑态不被退出操作影响）');

  // ===== 7. 最后一名成员退出 → 会话与消息整体删除 =====
  const convG = await J(`${BASE}/api/chat/conversations`, tkB, {
    method: 'POST', body: JSON.stringify({ type: 'user', members: ['bob'] }),
  });
  assert(convG.status === 201, `bob 建单人会话（members 仅自己，id=${convG.body.id}）`);
  const gId = convG.body.id;
  await sendMsg(tkB, gId, '自言自语');
  const delLast = await removeConv(tkB, gId);
  assert(delLast.status === 200 && delLast.body.removed === 'all',
    `最后一名成员退出 → removed=all（实测 ${delLast.body && JSON.stringify(delLast.body)}）`);
  // dev 驱动：直接读落盘 JSON 验证会话与消息均已物理删除（等价 getConversation 为 null）
  const db = JSON.parse(await fs.promises.readFile(files.CHAT_DEV_PATH, 'utf8'));
  assert(!db.conversations.some((c) => String(c.id) === String(gId)), '落盘数据：会话已被删除（getConversation 为 null）');
  assert(!db.messages.some((m) => String(m.conversation_id) === String(gId)), '落盘数据：该会话全部消息已被删除');
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
