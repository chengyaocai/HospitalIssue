// 公共：零依赖的 headless-Chromium + CDP 工具（供 layout-*.test.mjs 复用）。
//
// 为什么不用 puppeteer/playwright 包：本机已装有 Playwright 下载的 chromium 可执行文件，
// 缺的只是 npm 包。Node 22 自带全局 WebSocket，直连 DevTools 协议即可完成
// 「加载页面 → 注入脚本 → 量 getBoundingClientRect / getComputedStyle → 截图」，
// 因此不需要新增任何依赖（项目约定：前端只有 vue）。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

// —— 定位 Chromium（Playwright 下载的版本；找不到返回 null，调用方据此 SKIP）——
export function findChromium() {
  const bases = [
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort();
    for (const d of dirs.reverse()) {
      for (const rel of [
        path.join('chrome-win64', 'chrome.exe'),
        path.join('chrome-win', 'chrome.exe'),
        path.join('chrome-linux', 'chrome'),
        path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ]) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

// DevTools 的 HTTP 端点（/json/version 等）
export function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function waitDevtools(port, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { return await getJson(`http://127.0.0.1:${port}/json/version`); } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('DevTools 端口未就绪');
}

export function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  return {
    ready,
    send(method, params = {}) {
      id += 1;
      const myId = id;
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

// 启动一个 headless Chromium。
//
// ⚠️ 视口宽度：styles.css 里有 `@media (max-width:1100px)`（会切到「移动版」侧栏宽度 204px），
// 因此断言排版时视口必须 ≥1101px，否则量到的绝对值与生产不是同一套布局。
export function startChrome({ port, width = 1280, height = 900 }) {
  return spawn(findChromium(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--user-data-dir=' + path.join(os.tmpdir(), `cdp-profile-${port}`),
    'about:blank',
  ], { stdio: 'ignore' });
}

// 开一个新标签页并连上它。注意：/json/new 在部分版本只接受 PUT（GET 返回 405）。
export async function openPage(port, url) {
  const target = await getJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 'PUT')
    .catch(() => getJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`));
  const cdp = createCdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  transport.set(cdp, { port, id: target.id });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

// 记录 page → {port,id}，供 closePage() 用（避免调用方自己传一堆参数）
const transport = new Map();

export function clearTransport() { transport.clear(); }

export async function closePage(cdp) {
  const info = transport.get(cdp);
  try { cdp.close(); } catch { /* ignore */ }
  if (info) {
    transport.delete(cdp);
    await getJson(`http://127.0.0.1:${info.port}/json/close/${info.id}`).catch(() => {});
  }
}

// 等两帧，确保样式/布局已应用（比 sleep 可靠）
export async function settle(cdp) {
  await cdp.send('Runtime.evaluate', {
    expression: 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
    awaitPromise: true,
  });
}

// 等所有进行中的 CSS 动画/过渡结束再量颜色。
// ⚠️ 为什么必须等：styles.css:47 的全局 `button { transition: background .15s, border-color .15s, ... }`
// 会让**任何**按钮的背景/边框在改值后 150ms 内渐变。若在渐变途中读 getComputedStyle，
// 拿到的既不是旧值也不是新值（例如 rgb(239,245,255) 而非 rgb(248,250,252)）——
// v1.18.9 的「反向验证」第一次就是被这个坑住、断言假失败。
export async function waitAnimations(cdp, timeoutMs = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = await evaluate(cdp, `(document.getAnimations ? document.getAnimations().filter(a=>a.playState==='running').length : 0)`).catch(() => 0);
    if (!n) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

// 在页面里求值并取值。
// ⚠️ 表达式若返回 Promise（async IIFE / fetch），必须传 awaitPromise:true，
// 否则拿到的是一个序列化后的 `{}`（Promise 对象不可序列化），而且页面一导航就会把请求掐断。
export async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('页面内求值异常：' + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
  return r.result.value;
}

// 轮询等待页面里的条件成立（返回 true）或超时
export async function waitFor(cdp, expr, label, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const okv = await evaluate(cdp, `(() => { try { return !!(${expr}); } catch { return false; } })()`).catch(() => false);
    if (okv) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('等待超时：' + label);
}

export async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}
