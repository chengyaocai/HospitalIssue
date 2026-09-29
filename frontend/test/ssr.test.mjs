// 无浏览器环境下的「真渲染」前端校验（可重复运行）。
// 做法：用 vite 把待验组件打成 SSR 包 → 用 vue/server-renderer 在 Node 里真渲染 → 断言 DOM。
// 比只读源码强得多：能验证标签默认激活项、初态是否有弹框、边界数据不抛异常、产物无 NaN/Infinity。
//
// 用法：cd frontend && node test/ssr.test.mjs
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // frontend/
const entryFile = path.join(here, '.ssr-entry.mjs');
const outDir = path.join(here, '.ssr-tmp');

// —— 1) 生成 SSR 入口（临时文件，运行结束即清理）——
fs.writeFileSync(entryFile, `
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import OrgSwitcher from './src/components/OrgSwitcher.vue';
import OrgManage from './src/components/OrgManage.vue';
import UserManage from './src/components/UserManage.vue';
import NotificationBell from './src/components/NotificationBell.vue';
import ProblemDetail from './src/components/ProblemDetail.vue';

// onMounted 在 SSR 下不会执行，因此组件不会发请求。
export async function run() {
  const out = {};

  // 机构条：可切换态（两个机构，当前为 org 1；弹层初始收起）
  // v1.18.9：形态由父组件通过 canSwitch 传入（按"当前用户能否访问到第二个机构"判定）
  out.switcher = await renderToString(createSSRApp({
    render: () => h(OrgSwitcher, {
      current: { id: 1, code: 'default', name: '海盐县人民医院', active: true },
      orgs: [
        { id: 1, code: 'default', name: '海盐县人民医院', active: true },
        { id: 2, code: 'zyy', name: '海盐县中医院', active: false },
      ],
      switching: false,
      canSwitch: true,
    }),
  }));

  // 机构条：可切换态 + 切换中
  out.switcherSwitching = await renderToString(createSSRApp({
    render: () => h(OrgSwitcher, {
      current: { id: 2, code: 'zyy', name: '海盐县中医院', active: true },
      orgs: [
        { id: 1, code: 'default', name: '海盐县人民医院', active: true },
        { id: 2, code: 'zyy', name: '海盐县中医院', active: true },
      ],
      switching: true,
      canSwitch: true,
    }),
  }));

  // 机构条：**只读态（v1.18.9）** —— 只有一个机构的用户也必须看到自己在哪个机构，
  // 但不能出现下拉箭头 / 可点按钮。这是本次改动的核心，必须锁住。
  out.switcherRo = await renderToString(createSSRApp({
    render: () => h(OrgSwitcher, {
      current: { id: 1, code: 'default', name: '海盐县人民医院', active: true },
      orgs: [{ id: 1, code: 'default', name: '海盐县人民医院', active: true }],
      switching: false,
      canSwitch: false,
    }),
  }));

  // 机构条：无当前机构（边界）
  out.switcherEmpty = await renderToString(createSSRApp({
    render: () => h(OrgSwitcher, { current: null, orgs: [], switching: false, canSwitch: false }),
  }));

  // 机构管理页：初始空列表（所有弹框应为关闭态）
  out.manage = await renderToString(createSSRApp({
    render: () => h(OrgManage, { currentOrgId: 1 }),
  }));

  // 机构管理页：currentOrgId 为空（边界）
  out.manageNoCurrent = await renderToString(createSSRApp({
    render: () => h(OrgManage, { currentOrgId: null }),
  }));

  // 用户管理页：setup 层冒烟（权限设置弹框内的「平台级功能」分支需交互才能打开，
  // 无法在 SSR 中展开，此处只保证 setup 与初始模板不抛异常、弹框初始关闭）。
  out.userManage = await renderToString(createSSRApp({
    render: () => h(UserManage, {
      currentOrg: { id: 1, code: 'default', name: '海盐县人民医院' },
      canPlatformAdmin: true,
    }),
  }));

  // 浮动通知铃铛（v1.18.4 改了徽标样式）：初始未读为 0 -> 只渲染圆形按钮、面板收起、不出现徽标
  out.notificationBell = await renderToString(createSSRApp({
    render: () => h(NotificationBell, { canSend: true, canBroadcast: true }),
  }));

  // 问题详情抽屉（v1.18.5 关注附件文件名渲染）：中文名必须逐字原样渲染，不得出现替换字符
  out.detail = await renderToString(createSSRApp({
    render: () => h(ProblemDetail, {
      problem: {
        id: 101,
        title: '门诊叫号系统异常',
        status: '处理中',
        type: '故障',
        severity: '中',
        department: '门诊部',
        reporter: '张三',
        description: '叫号偶尔不刷新',
        created_at: '2026-09-23T08:00:00.000Z',
        attachments: [
          { id: 'f1', originalName: '会议纪要2026.pdf', storedName: 'a'.repeat(24) + '.pdf', size: 2048, uploadedBy: 'admin' },
          { id: 'f2', originalName: '内网IP端口分配表.xlsx', storedName: 'b'.repeat(24) + '.xlsx', size: 15360, uploadedBy: 'admin' },
        ],
      },
      canEdit: true, canDelete: true, canRate: true,
    }),
  }));

  // 问题详情抽屉：无附件（空态），边界不抛异常
  out.detailEmpty = await renderToString(createSSRApp({
    render: () => h(ProblemDetail, {
      problem: { id: 102, title: '无附件记录', attachments: [], created_at: '2026-09-23T08:00:00.000Z' },
    }),
  }));

  return out;
}
`, 'utf8');

// —— 2) 打包为 SSR bundle ——
await build({
  root: here,
  configFile: false,
  logLevel: 'warn',
  plugins: [vue()],
  build: {
    ssr: entryFile,
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: 'ssr-entry.mjs' },
      external: ['vue', 'vue/server-renderer'],
    },
  },
});

// —— 3) 真渲染 + 断言 ——
let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const has = (hay, needle, name) => ok(name, hay.includes(needle), '缺少「' + needle + '」');
const lacks = (hay, needle, name) => ok(name, !hay.includes(needle), '不该出现「' + needle + '」');

try {
  const mod = await import(pathToFileURL(path.join(outDir, 'ssr-entry.mjs')).href + '?t=' + Date.now());
  const out = await mod.run();

  console.log('--- 机构条 OrgSwitcher（可切换态）---');
  has(out.switcher, '当前机构', '含「当前机构」标签');
  has(out.switcher, '海盐县人民医院', '展示当前机构名');
  has(out.switcher, 'org-btn', '渲染了切换按钮');
  has(out.switcher, 'org-switch', '渲染了 org-switch 容器');
  has(out.switcher, 'org-cap', '含「当前机构」小标签（页眉单行布局，v1.18.6）');
  has(out.switcher, 'org-caret', '含下拉箭头');
  lacks(out.switcher, 'org-ro', '可切换态不出现只读形态');
  lacks(out.switcher, '仅此一个', '可切换态不出现「仅此一个」标记');
  lacks(out.switcher, 'org-txt', '不再使用侧栏时的纵向两行结构');
  lacks(out.switcher, 'org-pop', '弹层默认收起');
  lacks(out.switcher, '切换机构', '收起时不渲染机构列表');
  lacks(out.switcher, 'NaN', '无 NaN');
  lacks(out.switcher, 'Infinity', '无 Infinity');
  has(out.switcherSwitching, '切换中…', '切换中显示「切换中…」');
  has(out.switcherSwitching, '海盐县中医院', '切换中仍显示目标机构名');

  console.log('--- 机构条 OrgSwitcher（只读态，v1.18.9）---');
  has(out.switcherRo, '当前机构', '只读态仍含「当前机构」标签（每个用户都要看到自己在哪个机构）');
  has(out.switcherRo, '海盐县人民医院', '只读态展示当前机构名');
  has(out.switcherRo, 'org-ro', '渲染只读形态');
  has(out.switcherRo, 'org-switch', '仍渲染 org-switch 容器');
  has(out.switcherRo, 'org-switch ro', '容器带 ro 修饰类（供样式与测试定位）');
  has(out.switcherRo, '仅此一个', '只读态带「仅此一个」小标，解释为何不可切');
  lacks(out.switcherRo, 'org-btn', '只读态**没有**可点按钮');
  lacks(out.switcherRo, 'org-caret', '只读态**没有**下拉箭头');
  lacks(out.switcherRo, '<button', '只读态不含任何 button 元素（不参与键盘焦点、点了没反应）');
  lacks(out.switcherRo, 'org-pop', '只读态不渲染弹层');
  lacks(out.switcherRo, 'NaN', '只读态无 NaN');
  lacks(out.switcherEmpty, 'NaN', '空态无 NaN');
  has(out.switcherEmpty, '未选择机构', '无当前机构时回落「未选择机构」');

  console.log('--- 机构管理页 OrgManage ---');
  has(out.manage, '机构管理', '标题渲染');
  has(out.manage, '新建机构', '含新建按钮');
  has(out.manage, '机构列表', '含机构列表卡片');
  has(out.manage, '暂无机构', '空列表展示空态');
  has(out.manage, '成员数', '含成员数列');
  has(out.manage, '默认机构（ID 最小者）不可删除', '含守卫说明');
  lacks(out.manage, 'modal-mask', '弹框默认关闭');
  lacks(out.manage, 'NaN', '无 NaN');
  lacks(out.manage, 'Infinity', '无 Infinity');
  has(out.manageNoCurrent, '机构管理', 'currentOrgId 为空仍正常渲染');
  lacks(out.manageNoCurrent, '当前', '无当前机构时不标记「当前」');

  console.log('--- 用户管理页 UserManage ---');
  has(out.userManage, '用户列表', '含「用户列表」标签');
  has(out.userManage, '角色与权限', '含「角色与权限」标签');
  has(out.userManage, '当前机构', '页头显示当前机构');
  has(out.userManage, '海盐县人民医院', '展示当前机构名');
  lacks(out.userManage, 'modal-mask', '权限设置弹框默认关闭');
  lacks(out.userManage, 'NaN', '无 NaN');
  lacks(out.userManage, 'Infinity', '无 Infinity');

  console.log('--- 浮动通知铃铛 NotificationBell ---');
  has(out.notificationBell, 'nbell-btn', '渲染了圆形铃铛按钮');
  lacks(out.notificationBell, 'nbell-badge', '未读为 0 时不渲染徽标');
  lacks(out.notificationBell, 'nbell-panel', '面板默认收起');
  lacks(out.notificationBell, 'NaN', '无 NaN');
  lacks(out.notificationBell, 'Infinity', '无 Infinity');

  console.log('--- 问题详情抽屉 ProblemDetail（附件文件名） ---');
  has(out.detail, '附件（2）', '附件区块统计正确');
  has(out.detail, '会议纪要2026.pdf', '中文附件名逐字原样渲染');
  has(out.detail, '内网IP端口分配表.xlsx', '中英混排附件名原样渲染');
  has(out.detail, '门诊叫号系统异常', '问题标题渲染');
  has(out.detail, 'att-name', '附件名渲染为可点元素');
  has(out.detail, '下载 会议纪要2026.pdf', '下载按钮 title 使用完整中文名');
  lacks(out.detail, '\uFFFD', '无替换字符（未发生再解码损坏）');
  lacks(out.detail, 'NaN', '无 NaN');
  lacks(out.detail, 'Infinity', '无 Infinity');
  has(out.detailEmpty, '附件（0）', '无附件时统计为 0');
  has(out.detailEmpty, '暂无附件', '无附件时展示空态');
  lacks(out.detailEmpty, 'NaN', '空附件无 NaN');
} catch (e) {
  fail++;
  console.log('  FAIL 渲染过程抛异常 :: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(entryFile, { force: true });
}

console.log(`\nRESULT: passed=${pass} failed=${fail}`);
process.exit(fail === 0 ? 0 : 1);
