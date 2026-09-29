// 机构切换器（v1.18.9 两态；v1.18.19 迁入顶栏）的**真实应用渲染**断言：
// 单机构 = 半透明白只读标签，多机构 = 浅色药丸可点控件，且宿主是深色顶栏。
//
// 为什么需要它：v1.18.9 的诉求本身是视觉的 ——
//   ①「每个用户登录都需显示登录的机构」（单机构用户以前**根本看不到**机构条，
//      因为旧实现是 `v-if="orgs.length > 1"`）；
//   ②「增加颜色区分」，即一眼看出「这块能点」还是「这块只是告诉你信息」。
// v1.18.19 新增第三件事：机构切换器从内容区页眉（.app-head）迁到**顶栏**（深色宿主），
// 两态配色随宿主调整（可切换=浅色药丸 / 只读=半透明白低对比）——这同样只能真渲染量出来。
//
// 做法（与 layout-navbadge 同源，共用 test/_cdp.mjs）：
//   起一个 **真实的 dev 后端**（JSON 文件驱动、临时数据目录、独立端口），
//   用 headless Chromium 打开真实前端产物 → 在页面内登录并写入 token → 重新加载，
//   然后：
//     A. 只有一个机构时 → 量 `.org-ro`：必须是 span、cursor:default、无下拉箭头、有「仅此一个」，
//        且宿主是深色顶栏（.topbar）内、在顶栏内垂直居中；
//     B. 调接口建第 2 个机构后（创建者自动入机构）→ 量 `.org-btn`：必须是 button、有下拉箭头、可点开弹层；
//     C. 对比两态的 computed backgroundColor / borderColor —— 「颜色区分」的量化判据；
//     D. 顶栏品牌名恒为系统名称（与 document.title 同源），多机构下**不再**显示机构名。
//
// 运行：node test/layout-orgbar.test.mjs
// 若本机没有 ms-playwright 的 chromium，则打印 SKIP 并以 0 退出（不阻塞其它机器）。
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
  console.log('SKIP: 未找到 ms-playwright 的 chromium，跳过机构切换器布局测试（不影响其它测试）');
  process.exit(0);
}

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.error('  FAIL', msg); }
}

const CDP_PORT = 9333 + (process.pid % 500);
const APP_PORT = 3450 + (process.pid % 300);
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `orgbar-${n}-${stamp}.json`);

// —— 起真实 dev 后端（不连库）——
// ⚠️ cwd 必须是 backend/：config.js 的 dotenv.config() 无 path 参数，靠 CWD 找 .env。
const server = spawn(process.execPath, [path.join(backendDir, 'src', 'index.js')], {
  cwd: backendDir,
  env: {
    ...process.env,
    DB_DRIVER: 'dev',
    PORT: String(APP_PORT),
    JWT_SECRET: 'orgbar-layout-secret',
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
    UPLOADS_DIR: path.join(os.tmpdir(), `orgbar-uploads-${stamp}`),
  },
  stdio: 'ignore',
});

const BASE = `http://127.0.0.1:${APP_PORT}`;
const tempFiles = [
  tmp('issues'), tmp('users'), tmp('audit'), tmp('settings'),
  tmp('notif'), tmp('chat'), tmp('sched'), tmp('orgs'),
];

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

// 页面内求值：在真实前端里量机构切换器的形态、配色与「顶栏宿主」几何
const MEASURE = `(() => {
  const ro = document.querySelector('.org-ro');
  const btn = document.querySelector('.org-btn');
  const bar = document.querySelector('.topbar');
  const el = ro || btn;
  const cs = el ? getComputedStyle(el) : null;
  const r = el ? el.getBoundingClientRect() : null;
  const barR = bar ? bar.getBoundingClientRect() : null;
  const grp = document.querySelector('.topbar-right');
  const grpR = grp ? grp.getBoundingClientRect() : null;
  return JSON.stringify({
    hasRo: !!ro,
    hasBtn: !!btn,
    tag: el ? el.tagName : null,
    isRoleButton: el ? el.getAttribute('role') === 'button' : null,
    tabIndex: el ? el.tabIndex : null,
    cursor: cs ? cs.cursor : null,
    bg: cs ? cs.backgroundColor : null,
    border: cs ? cs.borderTopColor : null,
    shadow: cs ? cs.boxShadow : null,
    hasCaret: el ? !!el.querySelector('.org-caret') : false,
    cap: el ? (el.querySelector('.org-cap') || {}).textContent : null,
    name: el ? (el.querySelector('.org-name') || {}).textContent : null,
    only: el ? (el.querySelector('.org-only') || {}).textContent : null,
    w: r ? Math.round(r.width) : null,
    h: r ? Math.round(r.height) : null,
    // —— 顶栏宿主（v1.18.19）：切换器必须在 .topbar 内、垂直居中、靠右 ——
    inTopbar: el ? !!el.closest('.topbar') : false,
    topbarH: barR ? Math.round(barR.height) : null,
    // 垂直居中：切换器中心与顶栏中心的偏差（px）
    vOff: (r && barR) ? Math.abs((r.top + r.height / 2) - (barR.top + barR.height / 2)) : null,
    // 靠右：顶栏右侧整组（切换器 + 用户区）右缘距视口右缘 = 顶栏内边距量级，绝不应贴 0 或溢出
    groupRightPad: (grp && grpR) ? Math.round(window.innerWidth - grpR.right) : null,
    // 切换器在右组内、未被后续元素挤出（右缘不超过组的右缘）
    inGroup: (r && grpR) ? r.right <= grpR.right + 0.5 : false,
    // 顶栏品牌名（v1.18.19：恒为系统名称，与 document.title 同源）与机构名对照
    brand: (document.querySelector('.topbar-title') || {}).textContent,
    docTitle: document.title,
    popItems: document.querySelectorAll('.org-item').length,
    popOpen: !!document.querySelector('.org-pop'),
  });
})()`;

// 解析 'rgb(r, g, b)' → 数组
function rgb(s) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || '');
  return m ? [+m[1], +m[2], +m[3]] : null;
}
// 「蓝味」= 蓝通道 - 红通道：可切换态（浅蓝药丸）明显为正，半透明白/中性底接近 0
function blueness(s) {
  const c = rgb(s);
  return c ? c[2] - c[0] : NaN;
}

const chrome = startChrome({ port: CDP_PORT });
let cdp = null;

try {
  await waitServer();
  await waitDevtools(CDP_PORT);

  cdp = await openPage(CDP_PORT, BASE + '/');
  // 等文档 truly 落到应用源上（openPage 刚 navigate 时可能还是 about:blank，
  // 此时 origin 为 null，fetch('/api/...') 会直接抛错）
  await waitFor(cdp, `location.origin === '${BASE}' && document.readyState !== 'loading'`, '应用页面加载完成');
  // 登录：直接打接口拿 token 写进 localStorage（真实登录流程已被其它用例覆盖，这里只要登录态）
  const token = await evaluate(cdp, `(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const j = await r.json();
    if (!j.token) throw new Error('登录失败：' + JSON.stringify(j));
    localStorage.setItem('hit_token', j.token);
    localStorage.setItem('issue_tracker_view', 'dashboard');
    return j.token;
  })()`, { awaitPromise: true });
  ok(typeof token === 'string' && token.length > 20, '页面内登录成功并已写入 localStorage');

  // ===== A. 单机构：必须显示机构（以前完全看不到），且是**只读低对比标签** =====
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await waitFor(cdp, `document.querySelector('.topbar .org-ro')`, '单机构态顶栏只读切换器渲染');
  await settle(cdp);
  await waitAnimations(cdp);
  const a = JSON.parse(await evaluate(cdp, MEASURE));
  const shotA = await screenshot(cdp, path.join(root, 'test', 'orgbar-single-org.png'));

  ok(a.hasRo === true && a.hasBtn === false, '单机构：渲染只读机构标签（.org-ro），不渲染可切换按钮');
  ok(a.tag === 'SPAN', `单机构：只读标签不是 button（tag=${a.tag}）→ 不参与 Tab 焦点、点击无反应`);
  ok(a.isRoleButton === false && a.tabIndex === -1, '单机构：无 role=button、tabIndex=-1（确实不可聚焦）');
  ok(a.cursor === 'default', `单机构：光标为 default 而非 pointer（cursor=${a.cursor}）`);
  ok(a.hasCaret === false, '单机构：不显示下拉箭头（不给「可点」的视觉错觉）');
  ok((a.only || '').trim() === '仅此一个', `单机构：显示「仅此一个」小标解释为何不可点（实测「${(a.only || '').trim()}」）`);
  ok((a.cap || '').trim() === '当前机构', '单机构：带「当前机构」前缀，语义明确');
  ok(!!a.name && a.name.length > 0, `单机构：**显示所在机构名**（实测「${a.name}」）← 本需求核心诉求`);
  ok(a.popOpen === false, '单机构：不渲染下拉弹层');
  // —— 顶栏宿主（v1.18.19）——
  ok(a.inTopbar === true, '单机构：切换器宿主为顶栏 .topbar（内容区页眉 .app-head 已移除）');
  ok(a.topbarH >= 44 && a.topbarH <= 52, `顶栏高度约 48px（实测 ${a.topbarH}px）`);
  ok(a.vOff !== null && a.vOff < 3, `切换器在顶栏内垂直居中（中心偏差 ${a.vOff === null ? 'N/A' : a.vOff.toFixed(1)}px）`);
  ok(a.groupRightPad !== null && a.groupRightPad > 0 && a.groupRightPad < 60,
    `顶栏右组（切换器+用户区）靠右但不贴边/不溢出（右距视口 ${a.groupRightPad}px）`);
  ok(a.inGroup === true, '切换器位于顶栏右组内（右侧还有主题按钮与用户区，不要求最右）');
  ok(!!a.brand && a.brand.length > 0, `顶栏品牌名非空（实测「${a.brand}」）`);
  ok(a.brand === a.docTitle, `单机构：顶栏品牌名 = 机构级系统名称（与 document.title 同源：「${a.brand}」）`);
  console.log(`  INFO 单机构态：${a.w}×${a.h}px，bg=${a.bg}，border=${a.border}，topbar=${a.topbarH}px`);
  console.log(`  INFO 截图：${shotA}`);

  // ===== B. 造出第 2 个机构 → 同一用户应变成**浅色药丸可点控件** =====
  const mk = await fetch(BASE + '/api/orgs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ code: 'org2', name: '海盐县中医院' }),
  });
  const mkBody = await mk.json();
  ok(mk.status === 201, `建第二个机构成功（HTTP ${mk.status}，id=${mkBody.id}）`);

  await cdp.send('Page.navigate', { url: BASE + '/' });
  await waitFor(cdp, `document.querySelector('.topbar .org-btn')`, '多机构态顶栏可切换按钮渲染');
  await settle(cdp);
  await waitAnimations(cdp);
  const b = JSON.parse(await evaluate(cdp, MEASURE));
  const shotB = await screenshot(cdp, path.join(root, 'test', 'orgbar-multi-org.png'));

  ok(b.hasBtn === true && b.hasRo === false, '多机构：改渲染可切换按钮（.org-btn），不再渲染只读标签');
  ok(b.tag === 'BUTTON', `多机构：是可聚焦的真按钮（tag=${b.tag}, tabIndex=${b.tabIndex}）`);
  ok(b.cursor === 'pointer', `多机构：光标为 pointer（cursor=${b.cursor}）`);
  ok(b.hasCaret === true, '多机构：显示下拉箭头（提示可展开）');
  ok((b.only || '') === '' || b.only == null, '多机构：不显示「仅此一个」小标');
  ok(!!b.name && b.name.length > 0, `多机构：仍显示所在机构名（实测「${b.name}」）`);
  ok(b.inTopbar === true && b.topbarH >= 44 && b.topbarH <= 52 && b.vOff < 3,
    `多机构：同样宿主为顶栏且垂直居中（topbar=${b.topbarH}px，偏差 ${b.vOff.toFixed(1)}px）`);
  ok(b.brand === b.docTitle, `多机构：顶栏品牌名与 document.title 同源（「${b.brand}」）`);
  ok(b.brand === b.name, `多机构：顶栏品牌名 = 当前机构名，与右侧切换器同源（brand=「${b.brand}」= 机构=「${b.name}」，v1.18.20 行为）`);

  // ===== C. 「颜色区分」的量化判据（深色顶栏宿主：只读=半透明白≈0 蓝味，可切换=浅蓝药丸） =====
  ok(a.bg !== b.bg && a.border !== b.border,
    `两态配色确实不同：bg ${a.bg} → ${b.bg}；border ${a.border} → ${b.border}`);
  const bl = blueness(b.bg);
  const al = blueness(a.bg);
  ok(bl > al + 8, `可切换态为「浅色药丸（带蓝味）」、只读态为「半透明白低对比」（蓝味 ${al} → ${bl}）`);
  ok(blueness(b.border) > blueness(a.border) + 8,
    `边框同样区分（蓝味 ${blueness(a.border)} → ${blueness(b.border)}）`);
  ok(/inset/.test(b.shadow || ''), `可切换态用 inset 阴影画左侧主色竖条（不占布局宽度）：${(b.shadow || '').slice(0, 60)}`);
  ok(!/inset/.test(a.shadow || ''), '只读态无主色竖条阴影');

  // 反向验证：把可切换按钮的配色**改成与只读态逐字节相同**，色彩判据必须随之失效
  // （用实测色值而非 var()，避免变量解析差异让「反向验证」本身变得不可信）
  await evaluate(cdp, `(() => {
    const s = document.createElement('style');
    s.id = 'force-grey';
    // 必须一并关掉过渡：全局 button 规则带 transition:background .15s，
    // 否则会在渐变途中读到中间色（既非旧值也非新值），让「反向验证」假失败。
    s.textContent = '.org-btn{'
      + 'background:${a.bg}!important;border-color:${a.border}!important;'
      + 'box-shadow:none!important;transition:none!important;}';
    document.head.appendChild(s);
    return true;
  })()`);
  await settle(cdp);
  await waitAnimations(cdp);
  const b2 = JSON.parse(await evaluate(cdp, MEASURE));
  ok(b2.bg === a.bg && b2.border === a.border,
    `反向验证：已把可切换态刷成只读态同款配色（bg=${b2.bg}，border=${b2.border}）`);
  ok(!(blueness(b2.bg) > blueness(a.bg) + 8),
    `反向验证：配色拉平后「可切换态更蓝」的判据立即失效（蓝味 ${blueness(a.bg)} vs ${blueness(b2.bg)}）→ 色彩断言不是空转`);
  ok(b2.hasBtn === true, '反向验证：只改配色不改结构，结构判据仍然成立（说明两组断言各管一段，互不替代）');
  await evaluate(cdp, `(() => { const s = document.getElementById('force-grey'); if (s) s.remove(); return true; })()`);
  await settle(cdp);

  // ===== D. 弹层：点开后有 2 个机构可选 =====
  await evaluate(cdp, `(() => { document.querySelector('.org-btn').click(); return true; })()`);
  await settle(cdp);
  const d = JSON.parse(await evaluate(cdp, MEASURE));
  ok(d.popOpen === true, '点击后展开切换弹层');
  ok(d.popItems === 2, `弹层列出全部可访问机构（${d.popItems} 项，含当前机构）`);
  const shotD = await screenshot(cdp, path.join(root, 'test', 'orgbar-multi-org-open.png'));
  console.log(`  INFO 多机构态：${b.w}×${b.h}px，bg=${b.bg}，border=${b.border}，brand=「${b.brand}」`);
  console.log(`  INFO 截图：${shotB} / ${shotD}`);
} catch (e) {
  fail++;
  console.error('  FAIL 机构切换器布局测试异常：', (e && e.message) || e);
} finally {
  if (cdp) await closePage(cdp).catch(() => {});
  try { chrome.kill(); } catch { /* ignore */ }
  try { server.kill(); } catch { /* ignore */ }
  for (const f of tempFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

console.log(`\nRESULT: passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
