// 手动辅助工具（**不属于测试套件，不参与自动回归**）：
// 把 layout-orgbar.test.mjs 输出的三张截图裁到「右上角机构条」并排成一张说明图
// → test/orgbar-states.png，便于人工/向他人复核 v1.18.9 的视觉改动
// （实测色值与尺寸都写进图中，避免截图与结论脱节）。
//
// 用法：先跑 `node test/layout-orgbar.test.mjs`（生成三张源图），再跑本脚本。
// 注意：图里的实测数字是写死的文案，改了 CSS 后请同步更新，否则图片会与测试输出矛盾。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本脚本就在 frontend/test/ 下 —— 源图与产物都在同一目录，不要再多拼一层 'test'，
// 也不要用 '..'（那是 frontend/，里面没有截图）。
const TEST_DIR = __dirname;
const PORT = 9456;

const CHROME = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
if (!fs.existsSync(CHROME)) { console.log('no chromium'); process.exit(0); }

const b64 = (n) => fs.readFileSync(path.join(TEST_DIR, n)).toString('base64');
const single = b64('orgbar-single-org.png');
const multi = b64('orgbar-multi-org.png');
const multiOpen = b64('orgbar-multi-org-open.png');

// 三张源图都是 1280x900 的整页。机构条在右上角，约 x=1000..1270 / y=16..205
// （内容区右内边距 30px，视口 1280 → 右边缘 1250；控件实测宽 224（只读）/179（可切换）px）。
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#fff;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:26px 28px}
  h1{font-size:19px;color:#16233a;margin-bottom:4px}
  p.sub{font-size:12.5px;color:#64748b;margin-bottom:18px}
  .row{display:flex;gap:22px;align-items:flex-start}
  .cell{width:280px}
  .cap{font-size:13px;font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:7px;color:#16233a}
  .dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#2563eb}
  .dot.grey{background:#94a3b8}
  .dot.blue{background:#2563eb}
  .crop{width:280px;height:190px;overflow:hidden;border-radius:10px;border:1px solid #dbe3ee;box-shadow:0 2px 10px rgba(15,42,90,.08);background:#f7f9fc}
  .crop img{width:1280px;display:block;margin-left:-1000px;margin-top:-14px}
  .note{font-size:12px;color:#475569;margin-top:9px;line-height:1.65}
  .note b{color:#16233a}
  .rule{margin-top:20px;padding:13px 15px;border-radius:10px;background:#f6f9fe;border:1px solid #dbe7fb;font-size:12.5px;color:#334155;line-height:1.75}
  code{font-family:ui-monospace,Consolas,monospace;background:#eef3fb;padding:1px 5px;border-radius:4px;font-size:11.5px}
</style></head><body>
  <h1>右上角机构条：单机构只读 / 多机构可切换（v1.18.9）</h1>
  <p class="sub">真实前端产物 + 真实 dev 后端，Chromium 实测。三态唯一差别是「当前用户能访问几个机构」。</p>
  <div class="row">
    <div class="cell">
      <div class="cap"><span class="dot grey"></span>只有 1 个机构（只读）</div>
      <div class="crop"><img src="data:image/png;base64,${single}"></div>
      <div class="note"><b>灰底细边 + 无下拉箭头</b>，且元素是 <code>span</code>（不可聚焦、点了没反应）。<br>实测：<code>bg #f8fafc</code>、<code>cursor:default</code>、<code>tabIndex=-1</code>、蓝味 <b>4</b>。</div>
    </div>
    <div class="cell">
      <div class="cap"><span class="dot blue"></span>可访问 2 个机构（收起）</div>
      <div class="crop"><img src="data:image/png;base64,${multi}"></div>
      <div class="note"><b>主色蓝底 + 左侧蓝色竖条 + 下拉箭头</b>，真 <code>button</code>。<br>实测：<code>bg #eef4ff</code>、<code>border #c3d7fb</code>、<code>cursor:pointer</code>、蓝味 <b>17</b>（边框 56）。</div>
    </div>
    <div class="cell">
      <div class="cap"><span class="dot blue"></span>展开后可切换</div>
      <div class="crop"><img src="data:image/png;base64,${multiOpen}"></div>
      <div class="note">弹层右对齐、列出全部可访问机构，当前项打勾。<br>已停用机构会被置灰且不可点（后端也会 403 拒绝），避免「点谁都被拒」的假入口。</div>
    </div>
  </div>
  <div class="rule">
    <b>为什么这样分两态</b>：需求是「每个用户登录都要知道自己登的是哪个机构」，所以这一行<b>恒常渲染</b>（旧实现是 <code>v-if="orgs.length &gt; 1"</code>，单机构用户以前根本看不到机构）；而<b>能不能切换本身就是权限</b> —— 机构成员关系只能由平台管理员在「机构管理 → 成员管理」授予，所以「能访问到第二个机构」＝「被授权跨机构」。只有 1 个机构时渲染成灰色只读标签，就不必用一个弹层去告诉用户「你无处可切」。<br>
    <b>零位移细节</b>：左侧那条 3px 主色竖条是用 <code>box-shadow: inset 3px 0 0 var(--primary)</code> 画的，不是 <code>border-left</code> —— 后者会让文字整体右移 3px，两种形态切换时肉眼可见地跳一下。<br>
    <b>两态共用几何</b>：图标/字号/间距在 <code>.org-ico/.org-cap/.org-name</code> 里只声明一次，可切换态与只读态共享，切换机构数不会导致控件尺寸突变。
  </div>
</body></html>`;

const tmpHtml = path.join(os.tmpdir(), `cmp-orgbar-${Date.now()}.html`);
fs.writeFileSync(tmpHtml, html, 'utf8');

async function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.end();
  });
}
async function wait(url) { for (let i = 0; i < 100; i++) { try { return await getJson(url); } catch { /* */ } await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); }

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
  '--window-size=944,1200', '--hide-scrollbars', '--force-device-scale-factor=2',
  '--user-data-dir=' + path.join(os.tmpdir(), `cmp-orgbar-prof-${process.pid}`), 'about:blank'], { stdio: 'ignore' });

try {
  await wait(`http://127.0.0.1:${PORT}/json/version`);
  const url = 'file:///' + tmpHtml.replace(/\\/g, '/');
  const t = await getJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, 'PUT')
    .catch(() => getJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => { id += 1; const my = id; return new Promise((resolve, reject) => { pend.set(my, { resolve, reject }); ws.send(JSON.stringify({ id: my, method, params })); }); };
  await send('Runtime.enable'); await send('Page.enable');
  await new Promise((r) => setTimeout(r, 900));
  // 截图前量一下实际内容高度，避免底部被裁（视口高度必须 ≥ 内容高度，否则 clip 也救不回来）
  const h = await send('Runtime.evaluate', { expression: 'document.body.scrollHeight', returnByValue: true });
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 944, height: Math.ceil(h.result.value), scale: 2 } });
  fs.writeFileSync(path.join(TEST_DIR, 'orgbar-states.png'), Buffer.from(shot.data, 'base64'));
  ws.close();
  console.log('done → test/orgbar-states.png');
} catch (e) {
  console.error('ERR', e.message);
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
}
