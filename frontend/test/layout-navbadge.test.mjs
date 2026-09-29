// 侧栏「导航项 + 未读徽标」的真实布局断言（Chromium + CDP，无第三方依赖）。
//
// 为什么需要它：本项目所有其它测试都只能验「代码/产物里有什么字符串」，验证不到**排版**。
// v1.18.8 的 bug（居中导航被 margin-left:auto 徽标挤歪）是纯排版问题；v1.18.19 导航改为
// **左对齐分组结构**后，风险面变成：徽标若脱离「绝对定位」约定回到文档流，会紧贴名称右侧、
// 右侧留出参差不齐的空档，且不同条目的徽标位置不一致 —— 同样只有真实渲染才量得出来。
//
// 做法：起一个 headless Chromium，加载「真实 styles.css + 真实导航结构（组头 + 子项）」的页面，
// 用 getBoundingClientRect 量出「同一导航项在 有徽标 / 无徽标 两种状态下」图标与文字的横坐标，
// 以及徽标自身的位置。通过判据（不依赖任何像素调参）：
//   ① 两种状态下文字/图标左边界完全相同（徽标不参与排版）；
//   ② 徽标贴条目右侧（right:12px 铁律）、垂直居中；
//   ③ 子项为左对齐（图标紧随左侧内边距，不是居中布局）；
//   ④ 反向验证：把徽标改回文档流，判据 ①② 必须能抓到（证明断言非空转）。
//
// 运行：node test/layout-navbadge.test.mjs
// 若本机没有 ms-playwright 的 chromium，则打印 SKIP 并以 0 退出（不阻塞其它机器）。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  findChromium, waitDevtools, startChrome, openPage, closePage, settle, evaluate, screenshot,
} from './_cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

if (!findChromium()) {
  console.log('SKIP: 未找到 ms-playwright 的 chromium，跳过布局测试（不影响其它测试）');
  process.exit(0);
}

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.error('  FAIL', msg); }
}

const PORT = 9333 + (process.pid % 500);
const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

// 导航结构照抄 App.vue（v1.18.19 分组折叠导航；只保留断言需要的组 + 两个子项：一个无徽标、一个有徽标）。
// 徽标的存在与否由脚本在页面内动态切换，从而量出「同一项两种状态」的差值。
function buildHtml(extraCss) {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>
${css}
${extraCss}
</style></head><body>
<div class="sidebar" id="sb">
  <nav class="nav">
    <div class="nav-group">
      <button class="nav-group-head open" type="button">
        <span class="ico"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18"/></svg></span>
        <span class="nav-group-label">沟通协作</span>
        <svg class="nav-chev" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg>
      </button>
      <div class="nav-sub">
        <button class="nav-item" id="plain"><span class="ico"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18"/></svg></span>数据驾驶舱</button>
        <button class="nav-item" id="badged"><span class="ico"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18"/></svg></span>消息通知<span class="nav-badge" id="bdg">2</span></button>
      </div>
    </div>
  </nav>
</div>
</body></html>`;
}

const tmpHtml = path.join(os.tmpdir(), `navbadge-layout-${process.pid}.html`);

// 在页面里量：同一导航项在「有/无徽标」两态下，文字/图标左边界 + 徽标完整位置。
const MEASURE = `(() => {
  const textLeft = (btn) => {
    // 文字是裸文本节点，用 Range 才能取到它的盒子
    for (const n of btn.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) {
        const r = document.createRange();
        r.selectNodeContents(n);
        return { left: r.getBoundingClientRect().left, right: r.getBoundingClientRect().right };
      }
    }
    return null;
  };
  const snap = (id) => {
    const b = document.getElementById(id);
    const ico = b.querySelector('.ico').getBoundingClientRect();
    const item = b.getBoundingClientRect();
    const badge = b.querySelector('.nav-badge');
    const t = textLeft(b);
    const bg = badge ? badge.getBoundingClientRect() : null;
    return {
      iconLeft: ico.left,
      textLeft: t.left,
      textRight: t.right,
      itemLeft: item.left,
      itemRight: item.right,
      itemCY: item.top + item.height / 2,
      hasBadge: !!badge,
      badgeRight: bg ? bg.right : null,
      badgeCY: bg ? bg.top + bg.height / 2 : null,
    };
  };
  const out = {};
  // 有徽标态：把徽标放回去（HTML 里本来就带）
  out.badgedOn = snap('badged');
  out.plainOn = snap('plain');
  // 无徽标态：移掉徽标
  document.getElementById('bdg').remove();
  out.badgedOff = snap('badged');
  out.plainOff = snap('plain');
  // 把有徽标态恢复（供截图）
  const bdg = document.createElement('span');
  bdg.className = 'nav-badge'; bdg.id = 'bdg'; bdg.textContent = '2';
  document.getElementById('badged').appendChild(bdg);
  return JSON.stringify(out);
})()`;

async function runPage(label, extraCss) {
  fs.writeFileSync(tmpHtml, buildHtml(extraCss), 'utf8');
  const url = 'file:///' + tmpHtml.replace(/\\/g, '/');
  const cdp = await openPage(PORT, url);
  await settle(cdp);
  const m = JSON.parse(await evaluate(cdp, MEASURE));
  const img = await screenshot(cdp, path.join(root, 'test', `navbadge-${label}.png`));
  await closePage(cdp);
  return { m, img };
}

const chrome = startChrome({ port: PORT });

try {
  await waitDevtools(PORT);

  // ===== 1. 当前 CSS：左对齐布局 + 徽标绝对定位的全部判据 =====
  const fixed = await runPage('fixed');
  const m = fixed.m;
  const dIcon = Math.abs(m.badgedOn.iconLeft - m.badgedOff.iconLeft);
  const dText = Math.abs(m.badgedOn.textLeft - m.badgedOff.textLeft);
  const itemW = m.badgedOn.itemRight - m.badgedOn.itemLeft;
  const badgeGap = m.badgedOn.itemRight - m.badgedOn.badgeRight;   // right:12px → ≈12
  const badgeVOff = Math.abs(m.badgedOn.badgeCY - m.badgedOn.itemCY);
  const iconIndent = m.badgedOn.iconLeft - m.badgedOn.itemLeft;    // 左对齐 → ≈左内边距(14)
  // v1.18.21 起子项整体缩进 22px（.nav-sub margin 15 + padding 7），桌面条目宽 ≈186px；
  // 移动版侧栏（204px，无缩进差异）下条目 ≈158px —— 阈值取 170 区分两态。
  ok(itemW > 170, `视口产生了桌面版侧栏（条目宽 ${itemW.toFixed(1)}px > 170；窄于此说明掉进了移动版媒体查询）`);
  ok(m.badgedOn.hasBadge === true && m.badgedOff.hasBadge === false, '徽标可在页面内动态挂载/移除（两态确实不同）');
  // —— 徽标不参与排版：文字/图标位置在两态逐像素一致 ——
  ok(dText < 0.5, `有未读时名称与无未读时逐像素对齐（Δ=${dText.toFixed(2)}px）`);
  ok(dIcon < 0.5, `图标同样不受徽标影响（Δ=${dIcon.toFixed(2)}px）`);
  ok(Math.abs(m.plainOff.textLeft - m.plainOn.textLeft) < 0.5, '反衬：本就无徽标的导航项位置测两次完全一致（说明测量本身稳定，差异不来自抖动）');
  // —— 左对齐布局：图标紧随左侧内边距（若仍是居中布局，缩进会远大于内边距）——
  ok(iconIndent < 30, `子项左对齐：图标紧贴条目左内边距（缩进 ${iconIndent.toFixed(1)}px < 30px；居中布局下约为条宽一半）`);
  ok(m.badgedOn.textLeft > m.badgedOn.iconLeft, `子项结构为「图标在前、名称在后」（图标 ${m.badgedOn.iconLeft.toFixed(1)} < 名称 ${m.badgedOn.textLeft.toFixed(1)}）`);
  // —— 徽标位置铁律：贴条目右侧 12px + 垂直居中 ——
  ok(m.badgedOn.badgeRight <= m.badgedOn.itemRight + 0.5, '徽标不溢出导航项右边界');
  ok(badgeGap >= 10 && badgeGap <= 16, `徽标贴导航项右侧（右边缘距条目右边界 ${badgeGap.toFixed(1)}px ≈ right:12px）`);
  ok(badgeVOff < 1.5, `徽标垂直居中于条目（中心偏差 ${badgeVOff.toFixed(2)}px）`);
  // 徽标不能影响条目自身尺寸
  ok(Math.abs(m.badgedOn.itemRight - m.badgedOff.itemRight) < 0.5, '加徽标不改变条目宽度（徽标已脱离文档流）');
  console.log(`  INFO 当前实现：条目宽 ${itemW.toFixed(1)}px，图标缩进 ${iconIndent.toFixed(1)}px，` +
    `有徽标/无徽标 名称左边界 ${m.badgedOn.textLeft.toFixed(1)} / ${m.badgedOff.textLeft.toFixed(1)}，` +
    `徽标右距条目右缘 ${badgeGap.toFixed(1)}px（垂直偏差 ${badgeVOff.toFixed(2)}px）`);
  console.log(`  INFO 截图：${fixed.img}`);

  // ===== 2. 反向验证：把徽标改回文档流（position:static），测试必须能抓到（证明断言非空转）=====
  // 左对齐布局下旧 margin-left:auto 不再产生位移，因此新的回归面是「徽标回到文档流」：
  // 它会紧贴名称右侧，右侧留下大段空档 —— 右缘距离判据（≈12px）必须立即失效。
  const buggy = await runPage('buggy', '.nav-badge { position: static !important; transform: none !important; margin-left: 0 !important; }');
  const b = buggy.m;
  const buggyGap = b.badgedOn.itemRight - b.badgedOn.badgeRight;
  ok(buggyGap > 20, `反向验证：文档流徽标不再贴条目右侧（右缘距 ${buggyGap.toFixed(1)}px > 20）→ 右缘判据不是空转`);
  ok(b.badgedOn.hasBadge === true, '反向验证：徽标仍在（只改定位方式，不删元素）');
  console.log(`  INFO 旧实现（文档流）：徽标右缘距条目右边界 ${buggyGap.toFixed(1)}px（正确值应 ≈12px）`);
  console.log(`  INFO 截图：${buggy.img}`);
} catch (e) {
  fail++;
  console.error('  FAIL 布局测试异常：', (e && e.message) || e);
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  for (const f of [tmpHtml]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

console.log(`\nRESULT: passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
