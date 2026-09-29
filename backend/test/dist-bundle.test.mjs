// 构建产物端到端断言：真实启动后端（dev 驱动），确认它把 frontend/dist 送到浏览器，
// 且当前 bundle 里确实「编进了」本次新增的界面文案与接口路径（证明改动真的进了产物，而不只是源码里有）。
// 运行：cd backend && node test/dist-bundle.test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3412;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `${n}-distbundle-${stamp}.json`);
const tmpUploads = path.join(os.tmpdir(), `uploads-distbundle-${stamp}`);

const env = {
  ...process.env,
  DB_DRIVER: 'dev',
  DEV_DB_PATH: tmp('issues'),
  DEV_USERS_PATH: tmp('users'),
  AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'),
  NOTIFICATIONS_DEV_PATH: tmp('notifications'),
  CHAT_DEV_PATH: tmp('chat'),
  ORGS_DEV_PATH: tmp('orgs'),
  SCHEDULE_DEV_PATH: tmp('schedules'),
  UPLOADS_DIR: tmpUploads,
  PORT: String(PORT),
};
const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env, stdio: 'ignore' });

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

async function waitReady() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function cleanup() {
  server.kill();
  for (const f of [tmp('issues'), tmp('users'), tmp('audit'), tmp('settings'), tmp('notifications'), tmp('chat'), tmp('orgs'), tmp('schedules')]) {
    try { fs.unlinkSync(f); } catch {}
  }
  try { fs.rmSync(tmpUploads, { recursive: true, force: true }); } catch {}
}

try {
  const ready = await waitReady();
  assert(ready, '后端在 dev 驱动下可正常启动');
  if (!ready) throw new Error('server not ready');

  // 1) 首页 → 取出 bundle 名
  const indexRes = await fetch(BASE + '/');
  const html = await indexRes.text();
  assert(indexRes.status === 200 && html.includes('id="app"'), '根路径返回前端 index.html');
  const js = (html.match(/\/assets\/(index-[\w-]+\.js)/) || [])[1];
  const css = (html.match(/\/assets\/(index-[\w-]+\.css)/) || [])[1];
  assert(!!js, `index.html 引用了 JS bundle（${js || '未找到'}）`);
  assert(!!css, `index.html 引用了 CSS bundle（${css || '未找到'}）`);

  // 2) bundle 内容断言：v1.18 多机构界面必须真的编进产物
  const jsText = await (await fetch(`${BASE}/assets/${js}`)).text();
  const cssText = await (await fetch(`${BASE}/assets/${css}`)).text();
  const needJs = ['机构管理', '当前机构', '切换机构', '平台管理员', '成员管理', '加入机构', '新建机构', '跨机构管理权限', '/auth/switch-org', '/platform-admin',
    // v1.18.22：问题登记「引用到聊天」—— 弹框标题 / 空状态 / 留言占位 必须真的编进产物
    '引用到聊天', '暂无可发送的聊天会话，先去聊天页发起会话', '补充一句话（可选）',
    // v1.18.24：审核通过菜单「导出底稿登记」按钮与空结果提示文案必须真的编进产物
    '导出底稿登记', '当前没有已通过的问题可导出'];
  for (const k of needJs) assert(jsText.includes(k), `JS 产物含「${k}」`);
  // v1.18.2：权限设置弹框左栏的「平台级功能」分组（机构管理不可按机构角色授权，只做显式标注）
  const needJsPerm = ['平台级功能', '不能按机构角色勾选授权', '去用户列表设置'];
  for (const k of needJsPerm) assert(jsText.includes(k), `JS 产物含「${k}」`);
  assert(jsText.includes('/orgs'), 'JS 产物含 /orgs 接口路径');
  for (const k of ['.org-switch', '.role-pa', '.perm-group-title', '.perm-mod-lock']) assert(cssText.includes(k), `CSS 产物含样式 ${k}`);
  // v1.18.4：侧栏未读徽标与「有未读」强调（改良后的渐变红 + 定高居中 + 等宽数字）
  for (const k of ['.nav-badge', '.nav-item.has-unread', '#e11d48']) assert(cssText.includes(k), `CSS 产物含样式 ${k}`);
  assert(jsText.includes('has-unread'), 'JS 产物含导航项 has-unread 状态类');
  // v1.18.8：徽标必须脱离文档流（绝对定位）—— 否则徽标参与排版会扰动名称位置
  // （v1.18.8 的居中布局下把名称挤到最左；v1.18.19 起左对齐布局下徽标贴右侧的铁律不变）。
  const badgeRule = (cssText.match(/\.nav-badge\{[^}]*\}/) || [''])[0];
  assert(!!badgeRule, 'CSS 产物含 .nav-badge 规则本体');
  assert(/position:absolute/.test(badgeRule), '徽标为绝对定位（脱离文档流，不影响名称位置）');
  assert(!/margin-left:auto/.test(badgeRule), '徽标不再使用 margin-left:auto（会把居中项挤到最左）');
  assert(/right:12px/.test(badgeRule), '徽标贴导航项右侧（right:12px，与条目内边距对齐）');
  const navItemRule = (cssText.match(/\.nav-item\{[^}]*\}/) || [''])[0];
  assert(/justify-content:flex-start/.test(navItemRule), '导航项左对齐（v1.18.19 分组导航：显式 flex-start，不被全局 button 居中规则误伤）');
  assert(!/justify-content:center/.test(navItemRule), '导航项不再居中（v1.18.18 及以前的旧布局已移除）');
  assert(/position:relative/.test(navItemRule), '导航项为徽标提供定位参照（position:relative）');
  // v1.18.19：机构切换器迁往顶栏 + 侧栏分组折叠导航（组头 / 子项容器 / 顶栏样式必须真的编进产物）
  assert(jsText.includes('topbar'), 'JS 产物含顶栏 topbar（机构切换器与用户区的新宿主）');
  assert(jsText.includes('nav-group-head'), 'JS 产物含侧栏分组组头 nav-group-head');
  assert(jsText.includes('业务工作') && jsText.includes('沟通协作') && jsText.includes('系统管理'),
    'JS 产物含三个分组名（业务工作 / 沟通协作 / 系统管理）');
  assert(jsText.includes('当前机构'), 'JS 产物含「当前机构」文案');
  assert(cssText.includes('.topbar'), 'CSS 产物含 .topbar 顶栏样式');
  // v1.18.30：问题列表状态列彩色 pill（模板历史遗留的 .st 类名首次有样式）必须真的编进 CSS 产物；
  // 全局样式非 scoped，选择器无 data-v 后缀，直接查类名与关键色值
  assert(cssText.includes('.st-处理中') && cssText.includes('.st-已关闭'),
    'CSS 产物含状态列彩色样式 .st-处理中 / .st-已关闭（v1.18.30）');
  // v1.18.31：知识库卡片点击改弹框展示（原地展开移除）—— 弹框类名与关闭文案必须编进产物
  assert(jsText.includes('kb-modal') && jsText.includes('处理说明'),
    'JS 产物含知识库详情弹框（.kb-modal + 处理说明全文区，v1.18.31）');
  assert(cssText.includes('.kb-modal-head'), 'CSS 产物含知识库详情弹框样式 .kb-modal-head（v1.18.31）');
  // v1.18.32：用户管理操作列改单一下拉菜单（行内按钮过多）—— 菜单类名必须编进产物；
  // UserManage 是 scoped 样式，选择器带 data-v 后缀，取规则体时必须允许后缀（同 .org-btn 教训）
  assert(jsText.includes('ops-menu') && jsText.includes('ops-item'),
    'JS 产物含操作下拉菜单（.ops-menu / .ops-item，v1.18.32）');
  assert(/\.ops-menu(?:\[[^\]]*\])?\{/.test(cssText),
    'CSS 产物含操作下拉菜单样式 .ops-menu（v1.18.32）');
  assert(cssText.includes('#b45309') && cssText.includes('#15803d'),
    'CSS 产物含状态语义色（待处理黄 #b45309 / 已解决绿 #15803d，v1.18.30）');
  assert(cssText.includes('.nav-group-head'), 'CSS 产物含分组组头样式 .nav-group-head');
  assert(cssText.includes('.nav-sub'), 'CSS 产物含子项容器样式 .nav-sub');
  assert(!cssText.includes('.app-head'), 'CSS 产物不再含旧内容区页眉 .app-head（已移除，避免双份切换器）');
  assert(cssText.includes('.org-switch') && cssText.includes('.org-pop'), 'CSS 产物含机构条样式（按钮 + 弹层）');
  // v1.18.9：机构条拆成「可切换（彩色可点）/ 只读（灰色不可点）」两态，且页眉恒常渲染
  // 注意：OrgSwitcher 是 scoped 样式，产物里选择器带 [data-v-xxxx] 后缀 —— 取规则体时必须允许该后缀，
  // 否则 /\borg-btn\s*\{/ 这类正则会**匹配不到、断言静默空转**（v1.18.9 顺手修掉的一个假绿断言）。
  assert(cssText.includes('.org-ro'), 'CSS 产物含只读态样式 .org-ro');
  assert(jsText.includes('仅此一个'), 'JS 产物含只读态的「仅此一个」小标文案');
  const orgBtnRule = (cssText.match(/\.org-btn(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(!!orgBtnRule, 'CSS 产物含 .org-btn 规则本体（scoped 后缀容错）');
  assert(!/rgba\(255,\s*255,\s*255/.test(orgBtnRule), '切换器可切换态为实色浅色药丸（无半透明白底）');
  assert(/background:#eef4ff/.test(orgBtnRule), '可切换态用浅蓝药丸底（v1.18.9 颜色区分 + v1.18.19 深色顶栏宿主）');
  assert(/inset 3px 0 0 var\(--primary\)/.test(orgBtnRule), '可切换态左侧主色竖条（零位移画法）');
  const orgRoRule = (cssText.match(/\.org-ro(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(!!orgRoRule, 'CSS 产物含 .org-ro 规则本体');
  assert(!/var\(--primary\)/.test(orgRoRule), '只读态不使用主色（与可切换态形成颜色区分：低对比 = 只是告诉你信息）');
  assert(/rgba\(255,\s*255,\s*255/.test(orgRoRule), '只读态为半透明白（v1.18.19：深色顶栏宿主上的低对比只读形态）');
  // v1.18.10：平台管理员的机构内角色固定 → 界面必须用说明文字替代「改了不生效」的下拉
  assert(cssText.includes('.role-fixed'), 'CSS 产物含 .role-fixed（固定角色说明文字的样式）');
  assert(jsText.includes('roleFixed'), 'JS 产物含 roleFixed 分支（平台管理员不再渲染角色下拉）');
  assert(jsText.includes('· 固定'), 'JS 产物含「· 固定」标识文案（用户管理 + 机构管理两处）');
  assert(jsText.includes('storedRole'), 'JS 产物含 storedRole（tooltip 里可看到库里实存角色）');
  // v1.18.5：文件名乱码修复（api.js 的唯一 JSON 出口做显示层还原）必须真的编进产物
  assert(jsText.includes('originalName'), 'JS 产物含 originalName 字段处理');
  assert(jsText.includes('TextDecoder'), 'JS 产物含 TextDecoder（latin1→utf8 还原实现）');
  assert(jsText.includes('detail'), 'JS 产物含 detail 字段处理（操作日志里的文件名）');
  assert(!jsText.includes('NaN%'), 'JS 产物无 NaN% 这类脏插值');
  // v1.18.12：公司用户 / 院方用户区分 + 多机构分配界面必须真的编进产物
  assert(jsText.includes('用户类型'), 'JS 产物含「用户类型」（新建账号弹框的类型选择）');
  assert(jsText.includes('公司用户'), 'JS 产物含「公司用户」文案');
  assert(jsText.includes('分配机构'), 'JS 产物含「分配机构」按钮文案');
  assert(jsText.includes('userType'), 'JS 产物含 userType 字段（类型筛选 / chip / 切换按钮共用）');
  assert(jsText.includes('/memberships'), 'JS 产物含 memberships 接口路径');
  assert(jsText.includes('type-chip'), 'JS 产物含 type-chip（公司用户徽标类名）');
  // 注意 scoped CSS：选择器带 [data-v-xxx] 后缀，取规则体时必须允许该后缀
  const typeChipRule = (cssText.match(/\.type-chip(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(!!typeChipRule, 'CSS 产物含 .type-chip 规则本体（scoped 后缀容错）');
  assert(/background:#eef4ff/.test(typeChipRule), '公司用户 chip 用主色蓝底（与 .org-btn 同一色系）');
  // v1.18.13：排班跨机构同步（按钮 / 方向文案 / 接口路径必须真的编进产物）
  assert(jsText.includes('跨机构同步'), 'JS 产物含「跨机构同步」按钮文案');
  assert(jsText.includes('推送到其他机构'), 'JS 产物含「推送到其他机构」方向文案');
  assert(jsText.includes('从其他机构拉取'), 'JS 产物含「从其他机构拉取」方向文案');
  assert(jsText.includes('/schedules/sync'), 'JS 产物含 /schedules/sync 接口路径');
  const syncOrgRule = (cssText.match(/\.duty-sync-org(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(!!syncOrgRule, 'CSS 产物含 .duty-sync-org 规则本体（scoped 后缀容错）');
  // v1.18.18：跨机构同步升级为「带来源标记的镜像同步」—— 新说明文案与成功 toast 文案必须真的编进产物
  assert(jsText.includes('与源机构对齐'), 'JS 产物含镜像同步说明文案（与源机构对齐）');
  assert(jsText.includes('手工排的班不受影响'), 'JS 产物含镜像同步说明文案（手工排的班不受影响）');
  assert(jsText.includes('同步完成：新增'), 'JS 产物含同步成功 toast 文案（同步完成：新增…）');
  assert(jsText.includes('排班已一致'), 'JS 产物含零变更 toast 文案（排班已一致，无需变更）');
  // v1.18.14：消息撤回/复制 + 会话移除（文案 / 接口路径 / 样式必须真的编进产物）
  assert(jsText.includes('消息已被撤回'), 'JS 产物含「消息已被撤回」占位文案（v1.18.33 统一墓碑文案）');
  assert(jsText.includes('已复制'), 'JS 产物含「已复制」toast 文案');
  assert(jsText.includes('移除'), 'JS 产物含「移除」按钮文案');
  assert(jsText.includes('下次发消息会自动新建会话'), 'JS 产物含 AI 会话删除确认文案');
  assert(jsText.includes('其他成员不受影响'), 'JS 产物含同事会话退出确认文案');
  assert(jsText.includes('/recall'), 'JS 产物含 /recall 撤回接口路径');
  const recallRule = (cssText.match(/\.msg-act(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(!!recallRule, 'CSS 产物含 .msg-act 悬浮操作按钮样式（scoped 后缀容错）');
  // v1.18.15：用户管理的「类型筛选」从下拉改为二级 sheet 页（复用 Tabs 组件），必须真的编进产物
  assert(jsText.includes('sub-tabs'), 'JS 产物含 sub-tabs（类型筛选二级 sheet 页包裹容器类名）');
  assert(jsText.includes('院方用户') && jsText.includes('公司用户'), 'JS 产物含二级 sheet 页标签「院方用户」「公司用户」');
  const subTabsRule = (cssText.match(/\.sub-tabs(?:\[[^\]]*\])?\s*\.tab\{[^}]*\}/) || [''])[0];
  assert(!!subTabsRule, 'CSS 产物含 .sub-tabs .tab 紧凑变体规则（scoped 后缀容错）');
  assert(/font-size:12\.5px/.test(subTabsRule), '二级 sheet 页字号小于一级 tabs（紧凑层级）');
  // v1.18.16：处理人候选改为「本机构公司用户」实时派生 —— 系统设置的「处理人候选名单」维护界面已移除：
  // 新的来源提示文案必须编进产物；旧 add-row 变体类名 .handlers-add 不应再出现在产物里。
  assert(jsText.includes('无需在此维护'), 'JS 产物含处理人候选新来源提示（取自公司用户，无需在此维护）');
  assert(jsText.includes('候选取自本机构的'), 'JS 产物含下拉空态来源提示（登记 / 排班表单）');
  assert(!cssText.includes('handlers-add'), 'CSS 产物不再含旧处理人 add-row 变体类名 .handlers-add（维护界面已移除）');
  // v1.18.17：用户联系电话（新建弹框选填 / 列表电话列 / 行内「改电话」弹框）必须真的编进产物
  assert(jsText.includes('联系电话'), 'JS 产物含「联系电话」文案（新建弹框选填项）');
  assert(jsText.includes('改电话'), 'JS 产物含「改电话」按钮文案');
  // 注意 scoped CSS：选择器带 [data-v-xxx] 后缀，取规则体时必须允许该后缀
  const colPhoneRule = (cssText.match(/\.col-phone(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(!!colPhoneRule, 'CSS 产物含 .col-phone 规则本体（电话列窄列样式，scoped 后缀容错）');
  const phoneModalRule = (cssText.match(/\.phone-modal(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(!!phoneModalRule, 'CSS 产物含 .phone-modal 规则本体（改电话小弹框样式，scoped 后缀容错）');
  // v1.18.27：运维知识库（派生视图、自动收录）界面必须真的编进产物
  assert(jsText.includes('运维知识库'), 'JS 产物含「运维知识库」（导航菜单与页面标题）');
  assert(jsText.includes('自动收录'), 'JS 产物含「自动收录」说明文案（无需手工维护）');
  assert(jsText.includes('/problems/kb'), 'JS 产物含 /problems/kb 接口路径');
  // v1.18.28: 数据驾驶舱「平均处理时长」改按工作日 8 小时折算 —— 口径提示文案必须真的编进产物
  assert(jsText.includes('按工作日 8 小时折算'), 'JS 产物含平均处理时长「按工作日 8 小时折算」口径提示');
  // v1.18.29：聊天「新建会话」选成员列表按类型分二级 sheet 页 —— 「院方用户/公司用户」标签与
  // UserManage 复用无法区分，改断言 Chat 特有的类型空态文案必须真的编进产物
  assert(jsText.includes('该类型下暂无可添加的同事'), 'JS 产物含 Chat 选成员类型空态文案「该类型下暂无可添加的同事」');
  // v1.18.34：每个界面底部增加版权信息 + 版本号（全局页脚 + 登录页版权条）必须真的编进产物
  assert(jsText.includes('版权所有'), 'JS 产物含「版权所有」文案（页脚版权信息，v1.18.34）');
  assert(jsText.includes('软件问题登记系统'), 'JS 产物含「软件问题登记系统」版权主体名（v1.18.34）');
  assert(jsText.includes('v1.18.46'), 'JS 产物含版本号 v1.18.46（来自 src/version.js，v1.18.46）');
  // v1.18.41：用户管理「在线」列必须真的编进产物（API 封装 + 在线/离线文案）
  assert(jsText.includes('userPresence'), 'JS 产物含在线状态 API 封装 userPresence（v1.18.41）');
  assert(jsText.includes('在线') && jsText.includes('离线'), 'JS 产物含在线/离线列文案（v1.18.41）');
  // v1.18.39：聊天气泡已读/未读回执必须真的编进产物（类名 + CSS 配色；文案已读/未读由 v1.18.37 断言覆盖）
  assert(jsText.includes('msg-receipt'), 'JS 产物含气泡回执类名 msg-receipt（v1.18.39）');
  assert(cssText.includes('.msg-receipt'), 'CSS 产物含气泡回执样式 .msg-receipt（v1.18.39）');
  assert(cssText.includes('.msg-receipt.unread'), 'CSS 产物含回执未读配色 .msg-receipt.unread（v1.18.39）');
  // v1.18.38：顶栏未读消息跑马灯必须真的编进产物（模板文案 + 类名 + CSS 滚动动画）
  assert(jsText.includes('条未读消息'), 'JS 产物含跑马灯文案「条未读消息」（v1.18.38）');
  assert(jsText.includes('unread-marquee'), 'JS 产物含跑马灯类名 unread-marquee（v1.18.38）');
  assert(cssText.includes('.unread-marquee'), 'CSS 产物含跑马灯样式 .unread-marquee（v1.18.38）');
  assert(cssText.includes('um-scroll'), 'CSS 产物含跑马灯滚动动画 um-scroll（v1.18.38）');
  // v1.18.40：实施协同 · 工时登记必须真的编进产物（侧栏分组 + 视图 + API 封装）
  assert(jsText.includes('实施协同'), 'JS 产物含侧栏分组「实施协同」（v1.18.40）');
  assert(jsText.includes('工时登记'), 'JS 产物含菜单「工时登记」（v1.18.40）');
  assert(jsText.includes('timesheet'), 'JS 产物含 timesheet API 封装（v1.18.40）');
  assert(jsText.includes('全部医院批量填报'), 'JS 产物含批量填报文案（v1.18.40）');
  // v1.18.43：工时配置（按用户隔离）必须真的编进产物（菜单 + 视图 + API 封装 + 个人语义文案）
  assert(jsText.includes('工时配置'), 'JS 产物含菜单「工时配置」（v1.18.43）');
  assert(jsText.includes('tsconfig'), 'JS 产物含 tsconfig 菜单 key 与 API 封装（v1.18.43）');
  assert(jsText.includes('tsMyConfig') && jsText.includes('tsSaveMyConfig') && jsText.includes('tsTestLogin'), 'JS 产物含工时配置三件 API 封装（v1.18.43）');
  assert(jsText.includes('保存我的工时配置') && jsText.includes('仅本人生效'), 'JS 产物含工时配置保存文案与个人语义（v1.18.43）');
  // v1.18.44：用户管理「最近登录」列必须真的编进产物（表头 + 列类名 + 列样式）
  assert(jsText.includes('最近登录') && jsText.includes('col-lastlogin'), 'JS 产物含「最近登录」列头与 col-lastlogin 类名（v1.18.44）');
  assert(cssText.includes('.col-lastlogin'), 'CSS 产物含最近登录列样式 .col-lastlogin（v1.18.44）');
  // v1.18.45：筛选多选（状态/类型/科室勾选式多选下拉）必须真的编进产物
  assert(jsText.includes('全部状态') && jsText.includes('ms-pop') && jsText.includes('已选'), 'JS 产物含多选下拉文案与 ms-pop 弹层（v1.18.45）');
  assert(cssText.includes('.ms-pop') && cssText.includes('.ms-item'), 'CSS 产物含多选下拉样式 .ms-pop/.ms-item（v1.18.45）');
  // v1.18.46：工时配置绑定表按用户动态拉取 + 自动匹配 + 服务连接（管理员）卡必须真的编进产物
  assert(jsText.includes('自动匹配') && jsText.includes('系统默认') && jsText.includes('未绑定'),
    'JS 产物含来源四态文案 个人/自动匹配/系统默认/未绑定（v1.18.46）');
  assert(jsText.includes('服务连接（管理员）') && jsText.includes('更换 Token'),
    'JS 产物含服务连接（管理员）卡与 Token 更新入口（v1.18.46）');
  assert(jsText.includes('tsServerConfig') && jsText.includes('tsUpdateServerToken') && jsText.includes('tsHospitals'),
    'JS 产物含工时 v1.18.46 三件 API 封装（v1.18.46）');
  assert(jsText.includes('PMIS_MCP_TOKEN'), 'JS 产物含环境变量提示文案 PMIS_MCP_TOKEN（v1.18.46）');
  assert(cssText.includes('.src.auto') && cssText.includes('.kv'), 'CSS 产物含自动匹配 chip 与 .kv 只读值样式（v1.18.46）');
  // v1.18.37：每个会话显示已读/未读状态文案必须真的编进产物
  assert(jsText.includes('未读') && jsText.includes('已读'), 'JS 产物含会话已读/未读状态文案（conv-status，v1.18.37）');
  assert(jsText.includes('app-foot'), 'JS 产物含页脚容器类名 app-foot（v1.18.34）');
  assert(jsText.includes('login-foot'), 'JS 产物含登录页版权条类名 login-foot（v1.18.34）');
  assert(cssText.includes('.app-foot'), 'CSS 产物含页脚样式 .app-foot（v1.18.34）');
  assert(cssText.includes('.login-foot'), 'CSS 产物含登录页版权条样式 .login-foot（v1.18.34）');
  // 页脚版权条用 flex 两端对齐（左版权 / 右版本），且版本号用等宽数字（tabular-nums）保证切换不跳动
  const appFootRule = (cssText.match(/\.app-foot(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(/justify-content:space-between/.test(appFootRule), '页脚版权与版本号两端对齐（space-between，v1.18.34）');
  // 等宽数字写在版本号子元素 .app-foot .ver 上（切换版本号时数字不跳动）
  const appFootVerRule = (cssText.match(/\.app-foot \.ver(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(!!appFootVerRule, 'CSS 产物含 .app-foot .ver 规则本体（版本号子元素，v1.18.34）');
  assert(/tabular-nums/.test(appFootVerRule), '页脚版本号用等宽数字（tabular-nums，v1.18.34）');
  const loginFootRule = (cssText.match(/\.login-foot(?:\[[^\]]*\])?\{[^}]*\}/) || [''])[0];
  assert(/position:absolute/.test(loginFootRule), '登录页版权条绝对定位（贴底，v1.18.34）');
  // v1.18.35：聊天视图撑满内容区 —— .content 列向 flex 的 auto margin 会让 fit-content 收缩成窄卡，
  // Chat 根规则必须显式 width:100%（被 max-width:1360 截断居中）+ flex 撑满剩余高度
  const chatRule = (cssText.match(/\.chat\[data-v-[^\]]*\]\{[^}]*\}/) || [''])[0];
  assert(!!chatRule, 'CSS 产物含 Chat 根规则 .chat[data-v-…]（聊天视图样式已编译，v1.18.35）');
  assert(/width:100%/.test(chatRule), 'Chat 根规则显式 width:100%（对抗列向 flex auto margin 的 fit-content 收缩，v1.18.35）');
  // v1.18.36：全局修复——.content 是列向 flex，`.content > section` 的 auto margin 让所有视图收缩为
  // fit-content（v1.18.34 引入 flex 后遗留、仅聊天在 v1.18.35 单点修过）。给 section 显式 width:100%
  // 恢复「撑满内容区、≤1360px 居中」的原布局行为（否则用户管理/机构管理等内容少的视图会缩成中间一条）。
  const csRule = (cssText.match(/\.content>section\{[^}]*\}/) || [''])[0];
  assert(!!csRule, 'CSS 产物含 .content>section 规则（v1.18.36）');
  assert(/width:100%/.test(csRule), '全局 section 显式 width:100% 撑满内容区（修复 v1.18.34 后所有界面收缩为 fit-content，v1.18.36）');
  assert(/flex:1 1 auto/.test(chatRule), 'Chat 根规则 flex:1 1 auto 撑满 .content 剩余高度（v1.18.35）');

  // 3) 静态资源以正确内容类型返回
  const jsRes = await fetch(`${BASE}/assets/${js}`);
  assert((jsRes.headers.get('content-type') || '').includes('javascript'), 'JS 以 javascript 内容类型返回');

  // 4) 未登录时受保护接口仍 401（确认鉴权链路未被静态托管短路）
  const meRes = await fetch(BASE + '/api/auth/me');
  assert(meRes.status === 401, '未登录访问 /api/auth/me 返回 401');
} catch (e) {
  failed++;
  console.error('  FAIL 异常：' + (e && e.message ? e.message : e));
} finally {
  cleanup();
}

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
