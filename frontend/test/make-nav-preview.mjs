// 一次性出图（保留备用）：真实产物 + 真实 dev 后端的「v1.18.19 顶栏 + 分组侧栏」全景截图。
//
// 做法：起 dev 后端（JSON 驱动、临时数据目录、独立端口）→ headless Chromium 打开真实前端
// → 页面内登录 → 全员广播一条通知（让「消息通知」出现真实未读徽标）→ 重载后截全页图。
// 输出：frontend/test/nav-preview.png（视口 1440×900，DPR 2）。
//
// 运行：node test/make-nav-preview.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findChromium, waitDevtools, startChrome, openPage, closePage, settle, evaluate, waitFor, waitAnimations, screenshot,
} from './_cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const backendDir = path.join(root, '..', 'backend');

if (!findChromium()) {
  console.log('SKIP: 未找到 ms-playwright 的 chromium，无法出图');
  process.exit(0);
}

const CDP_PORT = 9333 + (process.pid % 500);
const APP_PORT = 3450 + (process.pid % 300);
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `navpreview-${n}-${stamp}.json`);

const server = spawn(process.execPath, [path.join(backendDir, 'src', 'index.js')], {
  cwd: backendDir,
  env: {
    ...process.env,
    DB_DRIVER: 'dev',
    PORT: String(APP_PORT),
    JWT_SECRET: 'nav-preview-secret',
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'admin123',
    ADMIN_NAME: '系统管理员',
    DEV_DB_PATH: tmp('issues'),
    DEV_USERS_PATH: tmp('users'),
    AUDIT_DEV_PATH: tmp('audit'),
    SETTINGS_DEV_PATH: tmp('settings'),
    NOTIFICATIONS_DEV_PATH: tmp('notif'),
    CHAT_DEV_PATH: tmp('chat'),
    SCHEDULE_DEV_PATH: tmp('sched'),
    ORGS_DEV_PATH: tmp('orgs'),
    UPLOADS_DIR: path.join(os.tmpdir(), `navpreview-uploads-${stamp}`),
  },
  stdio: 'ignore',
});

const BASE = `http://127.0.0.1:${APP_PORT}`;
const tempFiles = [
  tmp('issues'), tmp('users'), tmp('audit'), tmp('settings'),
  tmp('notif'), tmp('chat'), tmp('sched'), tmp('orgs'),
];
const tempUploads = path.join(os.tmpdir(), `navpreview-uploads-${stamp}`);

async function waitServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(BASE + '/api/config');
      if (r.ok) return;
    } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('dev 后端未就绪');
}

const chrome = startChrome({ port: CDP_PORT, width: 1440, height: 900 });
let cdp = null;
const outFile = path.join(root, 'test', 'nav-preview.png');

try {
  await waitServer();
  await waitDevtools(CDP_PORT);

  cdp = await openPage(CDP_PORT, BASE + '/');
  await waitFor(cdp, `location.origin === '${BASE}' && document.readyState !== 'loading'`, '应用页面加载完成');

  // 登录 + 全员广播一条通知（让侧栏「消息通知」出现真实未读徽标）
  await evaluate(cdp, `(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const j = await r.json();
    if (!j.token) throw new Error('登录失败：' + JSON.stringify(j));
    localStorage.setItem('hit_token', j.token);
    localStorage.setItem('issue_tracker_view', 'dashboard');
    await fetch('/api/notifications/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + j.token },
      body: JSON.stringify({ title: '系统维护通知（截图演示）', body: '今晚 22:00 系统升级，请提前保存工作内容。' }),
    });
    return true;
  })()`, { awaitPromise: true });

  // 重载后：登录态 + 未读轮询拉到真实未读数
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await waitFor(cdp, `document.querySelector('.topbar') && document.querySelector('.nav-group-head')`, '顶栏与分组导航渲染');
  await settle(cdp);
  await waitAnimations(cdp);
  // 等「消息通知」徽标出现（未读轮询异步拉取）
  await waitFor(cdp, `document.querySelector('.nav-badge')`, '未读徽标出现').catch(() => {});
  // 展开「沟通协作」组，让侧栏里的真实未读徽标可见（默认只展开含当前视图的组）
  await evaluate(cdp, `(() => {
    const heads = [...document.querySelectorAll('.nav-group-head')];
    const h = heads.find((x) => (x.querySelector('.nav-group-label') || {}).textContent === '沟通协作');
    if (h) h.click();
    return true;
  })()`);
  await settle(cdp);

  // DPR 2 高清截图（1440×900 逻辑视口）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  });
  await settle(cdp);
  await screenshot(cdp, outFile);
  console.log('DONE', outFile);
} catch (e) {
  console.error('FAIL 出图异常：', (e && e.message) || e);
  process.exitCode = 1;
} finally {
  if (cdp) await closePage(cdp).catch(() => {});
  try { chrome.kill(); } catch { /* ignore */ }
  try { server.kill(); } catch { /* ignore */ }
  for (const f of tempFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { fs.rmSync(tempUploads, { recursive: true, force: true }); } catch { /* ignore */ }
}
