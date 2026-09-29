// 手动辅助工具（**不属于测试套件，不参与自动回归**）：
// 把 layout-navbadge.test.mjs 输出的两张截图 navbadge-buggy.png / navbadge-fixed.png
// 裁到「导航区」并排成一张 before/after 说明图 → test/navbadge-before-after.png，
// 便于人工/向他人复核视觉改动（文字与实测数字都写进图中，避免截图与结论脱节）。
//
// 用法：先跑 `node test/layout-navbadge.test.mjs`（生成两张源图），再跑本脚本。
// 注意：图里的实测数字是写死的文案，改了 CSS 或改了视口后请同步更新，否则图片会与测试输出矛盾。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本脚本就在 frontend/test/ 下 —— 源图与产物都在同一目录。
// ⚠️ 曾经写成 `path.join(__dirname,'test',name)` → 解析到 frontend/test/test/ 直接 ENOENT；
//    也曾经写成 `path.join(__dirname,'..')` → 那是 frontend/，里面没有截图。
const TEST_DIR = __dirname;
const PORT = 9455;

const CHROME = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
if (!fs.existsSync(CHROME)) { console.log('no chromium'); process.exit(0); }

const b64 = (p) => fs.readFileSync(p).toString('base64');
const before = b64(path.join(TEST_DIR, 'navbadge-buggy.png'));
const after = b64(path.join(TEST_DIR, 'navbadge-fixed.png'));

// 两张图都是 420x900 的整页；导航区大约在 y=10..220、x=0..210。用容器裁切并放大 1.35 倍便于观看。
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#fff;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:26px 28px}
  h1{font-size:19px;color:#16233a;margin-bottom:4px}
  p.sub{font-size:12.5px;color:#64748b;margin-bottom:20px}
  .row{display:flex;gap:26px;align-items:flex-start}
  .cell{width:410px}
  .cap{font-size:13px;font-weight:700;margin-bottom:9px;display:flex;align-items:center;gap:7px}
  .bad{color:#b91c1c}.good{color:#15803d}
  .dot{width:9px;height:9px;border-radius:50%;display:inline-block}
  .bad .dot{background:#dc2626}.good .dot{background:#16a34a}
  .crop{width:246px;height:132px;overflow:hidden;border-radius:10px;border:1px solid #dbe3ee;box-shadow:0 2px 10px rgba(15,42,90,.08);background:#0a1220}
  .crop img{width:1280px;display:block;margin-left:-2px;margin-top:-8px}
  .note{font-size:12px;color:#475569;margin-top:9px;line-height:1.65}
  .note b{color:#16233a}
  .rule{margin-top:22px;padding:13px 15px;border-radius:10px;background:#f6f9fe;border:1px solid #dbe7fb;font-size:12.5px;color:#334155;line-height:1.75}
  code{font-family:ui-monospace,Consolas,monospace;background:#eef3fb;padding:1px 5px;border-radius:4px;font-size:11.5px}
</style></head><body>
  <h1>侧栏「消息通知」有未读时的对齐：修复前 / 修复后</h1>
  <p class="sub">同一份真实 styles.css、同一段导航 DOM；唯一差别是徽标的定位方式。</p>
  <div class="row">
    <div class="cell">
      <div class="cap bad"><span class="dot"></span>修复前（margin-left:auto）</div>
      <div class="crop"><img src="data:image/png;base64,${before}"></div>
      <div class="note">「消息通知」被挤到<b>最左</b>，与上面居中的「数据驾驶舱」<b>不在一条线上</b>；红数字却贴在条目最右，<b>中间空出一大段</b>。<br>实测：名称左移 <b>49.5px</b>（有徽标 53.0 → 无徽标 102.5）。</div>
    </div>
    <div class="cell">
      <div class="cap good"><span class="dot"></span>修复后（position:absolute）</div>
      <div class="crop"><img src="data:image/png;base64,${after}"></div>
      <div class="note">「消息通知」与「数据驾驶舱」<b>左右对齐</b>，红数字贴在条目右侧、与名称之间只有正常间距。<br>实测：「有徽标 / 无徽标」文字左边界 <b>102.5 / 102.5px（Δ=0.00px）</b>。</div>
    </div>
  </div>
  <div class="rule">
    <b>根因</b>：全局 <code>button{justify-content:center}</code> 让所有按钮居中，而 <code>.nav-item</code> 从未声明 <code>justify-content</code>（居中一直是<b>隐式继承</b>来的）。徽标一旦以 <code>margin-left:auto</code> 参与排版，自动外边距会吃掉全部自由空间 → 居中失效 → 内容退回最左。<br>
    <b>修法</b>：徽标改 <code>position:absolute; right:12px; top:50%</code>（脱离文档流），并给 <code>.nav-item</code> 显式补上 <code>justify-content:center</code> 与 <code>position:relative</code>。
  </div>
</body></html>`;

const tmpHtml = path.join(os.tmpdir(), `cmp-${Date.now()}.html`);
fs.writeFileSync(tmpHtml, html, 'utf8');

async function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.end();
  });
}
async function wait(url) { for (let i = 0; i < 100; i++) { try { return await getJson(url); } catch { /* */ } await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); }

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
  '--window-size=900,620', '--hide-scrollbars', '--force-device-scale-factor=2',
  '--user-data-dir=' + path.join(os.tmpdir(), `cmp-prof-${process.pid}`), 'about:blank'], { stdio: 'ignore' });

try {
  await wait(`http://127.0.0.1:${PORT}/json/version`);
  const t = await getJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('file:///' + tmpHtml.replace(/\\/g, '/'))}`, 'PUT')
    .catch(() => getJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('file:///' + tmpHtml.replace(/\\/g, '/'))}`));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => { id += 1; const my = id; return new Promise((resolve, reject) => { pend.set(my, { resolve, reject }); ws.send(JSON.stringify({ id: my, method, params })); }); };
  await send('Runtime.enable'); await send('Page.enable');
  await new Promise((r) => setTimeout(r, 900));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(TEST_DIR, 'navbadge-before-after.png'), Buffer.from(shot.data, 'base64'));
  ws.close();
  console.log('done');
} catch (e) {
  console.error('ERR', e.message);
} finally {
  try { chrome.kill(); } catch {}
  try { fs.unlinkSync(tmpHtml); } catch {}
}
