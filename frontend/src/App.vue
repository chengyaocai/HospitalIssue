<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, watchEffect, nextTick } from 'vue';
import { api, getToken, setToken, clearToken, STATUSES, DEFAULT_PERMISSIONS, MENU_ORDER, BUILTIN_ROLES, DENY_ALL } from './api.js';
import FilterBar from './components/FilterBar.vue';
import ProblemList from './components/ProblemList.vue';
import ProblemForm from './components/ProblemForm.vue';
import ProblemImport from './components/ProblemImport.vue';
import ProblemDetail from './components/ProblemDetail.vue';
import Cockpit from './components/Cockpit.vue';
import ExportButtons from './components/ExportButtons.vue';
import Login from './components/Login.vue';
import UserManage from './components/UserManage.vue';
import AuditLogPanel from './components/AuditLog.vue';
import ChangePassword from './components/ChangePassword.vue';
import Settings from './components/Settings.vue';
import NotificationBell from './components/NotificationBell.vue';
import NotificationCenter from './components/NotificationCenter.vue';
import DutyRoster from './components/DutyRoster.vue';
import Audited from './components/Audited.vue';
import KnowledgeBase from './components/KnowledgeBase.vue';
import FileManage from './components/FileManage.vue';
import ServiceManage from './components/ServiceManage.vue';
import Chat from './components/Chat.vue';
import CiteToChat from './components/CiteToChat.vue';
import OrgSwitcher from './components/OrgSwitcher.vue';
import OrgManage from './components/OrgManage.vue';
import Timesheet from './components/Timesheet.vue';
import TimesheetSettings from './components/TimesheetSettings.vue';
// v1.18.51：AI 技能五模块（自 HIS.OPS 移植）
import WxpDraftQuery from './components/WxpDraftQuery.vue';
import TfsQuery from './components/TfsQuery.vue';
import PmisQuery from './components/PmisQuery.vue';
import ChangeRequest from './components/ChangeRequest.vue';
import GoLiveConfirm from './components/GoLiveConfirm.vue';
import { APP_VERSION } from './version.js';
import { unread, refreshUnread, startUnreadPolling, stopUnreadPolling, clearUnread } from './notifications.js';
import { unread as chatUnread, startChatPolling, stopChatPolling, refreshUnread as refreshChatUnread, clearUnread as clearChatUnread } from './chat.js';
import { sessionExpired, resetSessionExpired } from './authState.js';

const appName = ref('医院信息科 · 软件问题登记');
const view = ref('issues');
const filters = ref({ status: '', type: '', department: '', keyword: '' });
const recycle = ref(false);   // 回收站视图（v1.6 软删除）：true 时列表展示已删除问题
const list = ref({ rows: [], total: 0 });
const dash = ref(null);
const page = ref(1);
const PAGE_SIZES = [10, 20, 50];
const pageSize = ref(PAGE_SIZES.includes(Number(localStorage.getItem('issue_tracker_pageSize')))
  ? Number(localStorage.getItem('issue_tracker_pageSize'))
  : 10);
const selected = ref([]);
const bulkStatus = ref('');
const showForm = ref(false);
const showImport = ref(false);
const editing = ref(null);
const showPwd = ref(false);
const sort = ref({ by: 'created_at', order: 'desc' });
const detail = ref(null);

// v1.18.22：引用问题到聊天（CiteToChat 弹框）
const citeProblem = ref(null);
const showCite = ref(false);

const currentUser = ref(null);
const showLogin = ref(false);

// 多机构（v1.18）：当前机构 + 可访问机构列表（来自 /auth/login | /auth/me | /auth/switch-org）
const currentOrg = ref(null);
const orgs = ref([]);
const switchingOrg = ref(false);

// 角色权限（来自 /api/config；离线/异常时回落默认）
const permissions = ref(DEFAULT_PERMISSIONS);
// 角色列表（来自 /api/config 的 roles）：动态、可增删改
const roles = ref(BUILTIN_ROLES);
function roleLabel(key) {
  const r = roles.value.find((x) => x.key === key);
  return (r && r.label) || key || '';
}

// 当前登录角色的有效权限（deny-by-default：未知角色无任何权限）
const myPerms = computed(() => permissions.value[currentUser.value?.role] || DENY_ALL);
function canMenu(key) { return (myPerms.value.menus || []).includes(key); }
function can(action) { return myPerms.value.actions?.[action] === true; }
// 可停留的视图：消息通知对所有登录用户常显（它是「功能模块」而非菜单）；
// 机构管理同上，但仅平台管理员可见（跨机构操作，不属于任何机构内角色权限）；
// 值班表 / 审核通过已升级为权限菜单，按 canMenu 控制显隐，与其余菜单一致。
function canView(v) {
  if (v === 'notification') return true;
  if (v === 'orgs') return currentUser.value?.platformAdmin === true;
  return canMenu(v);
}
// 机构提示条（v1.18.9）：**每个用户都恒定显示自己在哪个机构**，不再限定机构数 > 1。
// 能不能切换，取决于「当前用户能不能访问到第二个机构」—— 这本身就是权限：
// 机构成员关系只能由平台管理员在「机构管理 → 成员管理」授予，因此「有 2 个机构」= 「被授权跨机构」。
// 已停用机构不算数（后端 switch-org 对已停用机构返回 403「该机构已停用，无法切换」），
// 否则会出现「有下拉可点、点谁都被拒」的假入口。
const switchableOrgs = computed(() => orgs.value.filter((o) => o.active !== false));
const canSwitchOrg = computed(() => switchableOrgs.value.length > 1);
// 登录态 + 已知当前机构时才渲染（登录页 / 切换过程中不闪出「未选择机构」）
const showOrgBar = computed(() => !!currentUser.value && !!currentOrg.value);
// 多机构时顶栏品牌显示**当前机构名**（v1.18.20：与右侧机构切换器同源，避免
// 「品牌=机构级系统名称（可能是默认机构名）」与「切换器=当前机构」对不上）；
// 单机构登录后仍显示机构级「系统名称」（appName）。
// v1.18.51：未登录（登录页，含自动退回）时浏览器标题固定为系统名称，不显示 appName。
const LOGIN_TITLE = '软件问题登记系统';
const brandName = computed(() =>
  (showOrgBar.value && orgs.value.length > 1 && currentOrg.value?.name)
    ? currentOrg.value.name
    : (showOrgBar.value ? appName.value : LOGIN_TITLE)
);
watchEffect(() => { document.title = brandName.value; });
// 是否可用批量操作（决定列表勾选列与批量条是否出现）
const canBulk = computed(() => can('issue.bulkStatus') || can('issue.bulkDelete'));

// ── 侧栏分组折叠导航（v1.18.19）──
// 仅视觉重组：不动权限判定（每个子项仍走 canView —— notification 恒显、orgs 仅平台管理员）。
// 子项元数据：label + 内联图标 key；badge 为未读数取值函数（有才显示）。
const NAV_ITEMS = {
  dashboard:    { label: '数据驾驶舱', icon: 'cockpit' },
  issues:       { label: '问题登记',   icon: 'issues' },
  audited:      { label: '审核通过',   icon: 'audited' },
  kb:           { label: '运维知识库', icon: 'kb' },
  files:        { label: '文件管理',   icon: 'files' },
  svcmanage:    { label: '业务服务管理', icon: 'svc' },
  schedule:     { label: '值班表',     icon: 'schedule' },
  chat:         { label: '聊天',       icon: 'chat',    badge: () => chatUnread.value },
  notification: { label: '消息通知',   icon: 'bell',    badge: () => unread.value },
  users:        { label: '用户管理',   icon: 'users' },
  audit:        { label: '操作日志',   icon: 'audit' },
  settings:     { label: '系统设置',   icon: 'settings' },
  orgs:         { label: '机构管理',   icon: 'orgs' },
  timesheet:    { label: '工时登记',   icon: 'timesheet' },
  tsconfig:     { label: '工时配置',   icon: 'tsconfig' },
  // v1.18.51：AI 技能五模块
  wxpdraft:     { label: 'WXP底稿查询',     icon: 'wxpdraft' },
  tfsquery:     { label: 'TFS 工作项查询',  icon: 'tfsquery' },
  pmisquery:    { label: 'PMIS交易查询',    icon: 'pmisquery' },
  changerequest:{ label: '变更申请单',      icon: 'changerequest' },
  golive:       { label: '应用上线确认单',  icon: 'golive' },
};
const NAV_GROUPS = [
  { key: 'work',  label: '业务工作', icon: 'group-work',  items: ['dashboard', 'issues', 'audited', 'kb', 'files', 'schedule', 'svcmanage'] },
  { key: 'comms', label: '沟通协作', icon: 'group-comms', items: ['chat', 'notification'] },
  { key: 'impl',  label: '实施协同', icon: 'group-impl',  items: ['timesheet', 'wxpdraft', 'tfsquery', 'pmisquery', 'changerequest', 'golive'] },
  { key: 'sys',   label: '系统管理', icon: 'group-sys',   items: ['users', 'audit', 'settings', 'orgs', 'tsconfig'] },
];
// 组内没有任何可见子项时整组隐藏；子项保持原菜单顺序
const navGroups = computed(() => NAV_GROUPS
  .map((g) => ({ ...g, items: g.items.filter((v) => canView(v)).map((key) => ({ key, ...NAV_ITEMS[key] })) }))
  .filter((g) => g.items.length > 0));
// 展开集合：默认展开「含当前视图的组」，不做持久化；点击组头切换
const expandedGroups = ref(new Set());
function groupKeyOf(v) { return (NAV_GROUPS.find((g) => g.items.includes(v)) || {}).key || null; }
function toggleGroup(key) {
  const s = new Set(expandedGroups.value);
  if (s.has(key)) s.delete(key); else s.add(key);
  expandedGroups.value = s;
}
// 视图变化（含右下角铃铛跳转等非菜单入口）时自动展开所在组，避免「当前项被折叠藏起来」
watch(view, (v) => {
  const k = groupKeyOf(v);
  if (k && !expandedGroups.value.has(k)) expandedGroups.value = new Set([...expandedGroups.value, k]);
});
// 导航内联图标（viewBox 24，stroke 风格统一；组图标与子项图标共用一套线宽）
const ICONS = {
  'group-work': '<rect x="3.5" y="7.6" width="17" height="12" rx="2.2" /><path d="M9 7.6V6a1.9 1.9 0 0 1 1.9-1.9h2.2A1.9 1.9 0 0 1 15 6v1.6M3.5 12.7h17" />',
  'group-comms': '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20l1.1-4.9A8.5 8.5 0 1 1 21 11.5z" />',
  'group-sys': '<path d="M12 3l7.5 2.8v5.3c0 4.6-3.1 8-7.5 9.9-4.4-1.9-7.5-5.3-7.5-9.9V5.8z" /><path d="M8.9 12l2.2 2.2 4.2-4.4" />',
  'group-impl': '<circle cx="12" cy="12" r="8.5" /><path d="M12 7.2V12l3.2 2.1" /><path d="M12 3.5v1.6M20.5 12h-1.6M12 20.5v-1.6M3.5 12h1.6" />',
  cockpit: '<rect x="3" y="3" width="7.5" height="9" rx="1.6" /><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6" /><rect x="13.5" y="12" width="7.5" height="9" rx="1.6" /><rect x="3" y="15.5" width="7.5" height="5.5" rx="1.6" />',
  issues: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.5" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />',
  audited: '<circle cx="12" cy="12" r="8.6" /><path d="M8 12.4l2.6 2.6L16.2 9.4" />',
  kb: '<path d="M4.5 5.2A2.2 2.2 0 0 1 6.7 3h12.8v14.8H6.7a2.2 2.2 0 0 0-2.2 2.2z" /><path d="M4.5 20V5.2M6.7 14.2h12.8" />',
  files: '<path d="M14.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14.5 3.5v5h5M12 12.5v5M9.5 15h5" />',
  // v1.18.82：业务服务管理（服务器机架图标）
  svc: '<rect x="3.5" y="3.5" width="17" height="6.5" rx="2" /><rect x="3.5" y="14" width="17" height="6.5" rx="2" /><path d="M7 6.75h.01M7 17.25h.01M10.5 6.75H17M10.5 17.25H17" />',
  schedule: '<rect x="3.5" y="4.5" width="17" height="16" rx="2.5" /><path d="M8 2.8v3.4M16 2.8v3.4M3.5 9.6h17" /><path d="M7.8 13.5h2.4M13.8 13.5h2.4M7.8 17h2.4" />',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20l1.1-4.9A8.5 8.5 0 1 1 21 11.5z" />',
  bell: '<path d="M18 8.5a6 6 0 0 0-12 0c0 6-2.2 7.5-2.2 7.5h16.4S18 14.5 18 8.5z" /><path d="M13.7 20a2 2 0 0 1-3.4 0" />',
  users: '<circle cx="9.5" cy="8" r="3.3" /><path d="M3.6 19.6c0-3.1 2.6-5.2 5.9-5.2s5.9 2.1 5.9 5.2" /><path d="M16.6 5.6a3 3 0 0 1 0 5.5M18.2 14.8c1.9.6 3.1 2.2 3.1 4.1" />',
  audit: '<path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" /><path d="M3.6 4.6V9h4.4" /><path d="M12 8.2V12l3 1.9" />',
  settings: '<circle cx="12" cy="12" r="3.4" /><path d="M12 2.6l1.3 2.6 2.8-.7.7 2.8 2.6 1.3-1.3 2.6 1.3 2.6-2.6 1.3-.7 2.8-2.8-.7L12 21.4l-1.3-2.6-2.8.7-.7-2.8-2.6-1.3L5.9 12 4.6 9.4l2.6-1.3.7-2.8 2.8.7z" />',
  orgs: '<path d="M4 21V6.5L12 3l8 3.5V21" /><path d="M4 21h16M9.5 21v-4.6h5V21" /><path d="M8.6 9.4h1.6M13.8 9.4h1.6M8.6 12.8h1.6M13.8 12.8h1.6" />',
  timesheet: '<circle cx="12" cy="12" r="8.5" /><path d="M12 7V12l3.4 2.2" /><path d="M8.2 3.9l.8 1.6M15.8 3.9l-.8 1.6" />',
  // v1.18.51：AI 技能五模块图标
  wxpdraft: '<rect x="4" y="3.5" width="16" height="17" rx="2.4" /><path d="M8 7.5h8M8 11h8M8 14.5h5" /><circle cx="15.5" cy="17" r="2.4" /><path d="M17.3 18.8l2 2" />',
  tfsquery: '<circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.3 15.3L20.5 20.5" /><path d="M7.8 10.5h5.4M10.5 7.8v5.4" />',
  pmisquery: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2" /><path d="M3.5 9h17M9 9v10.5" /><path d="M12.5 13h4.5M12.5 16h4.5" />',
  changerequest: '<rect x="5" y="3.5" width="14" height="17" rx="2.2" /><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" /><path d="M14.5 18.5l1.8 1.8 3.4-3.6" />',
  golive: '<path d="M12 20.5c4.7 0 8.5-3.8 8.5-8.5S16.7 3.5 12 3.5 3.5 7.3 3.5 12s3.8 8.5 8.5 8.5z" /><path d="M12 8v4.2l3 1.8" /><path d="M9.3 2.5h5.4" />',
  tsconfig: '<path d="M4 7h9M17.5 7H20M4 12h3M11.5 12H20M4 17h9M17.5 17H20" /><circle cx="15" cy="7" r="2" /><circle cx="7.5" cy="12" r="2" /><circle cx="15" cy="17" r="2" />',
};

// 菜单持久化：刷新后恢复到上次所在菜单（须仍有权限，否则回落第一个可用菜单）
const VIEW_KEY = 'issue_tracker_view';
function firstMenu() {
  for (const k of MENU_ORDER) if (canMenu(k)) return k;
  return 'issues';
}
function savedView() {
  const v = localStorage.getItem(VIEW_KEY);
  return v && canView(v) ? v : firstMenu();
}

// v1.18.50：多标签页（Sheet Tabs）状态与操作
const tabs = ref([]); // { view, title }
function tabTitle(v) { return NAV_ITEMS[v]?.label || v; }
function openTab(v) {
  if (!canView(v)) return;
  if (!tabs.value.find((t) => t.view === v)) {
    tabs.value.push({ view: v, title: tabTitle(v) });
  }
  view.value = v;
}
function closeTab(v) {
  const idx = tabs.value.findIndex((t) => t.view === v);
  if (idx === -1) return;
  tabs.value.splice(idx, 1);
  if (view.value === v) {
    const next = tabs.value[idx] || tabs.value[idx - 1];
    view.value = next ? next.view : firstMenu();
  }
}
// v1.18.51：AI 技能模块间跳转（查询页「变更申请单」按钮 → 打开变更申请单标签页）
window.addEventListener('ai-goto', (e) => {
  const target = String(e.detail || '');
  if (NAV_ITEMS[target]) openTab(target);
});

// v1.18.50：标签条横向滚动 —— 显示不下时提供左右移动按钮
const tabScroller = ref(null);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
function updateTabScroll() {
  const el = tabScroller.value;
  if (!el) return;
  canScrollLeft.value = el.scrollLeft > 1;
  canScrollRight.value = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
}
function scrollTabs(dir) {
  const el = tabScroller.value;
  if (!el) return;
  el.scrollBy({ left: dir * 200, behavior: 'smooth' });
}
// 当前标签变化时滚入可视区（只滚标签容器，不带动页面/内容区滚动），并刷新左右按钮显隐
function ensureActiveTabVisible() {
  const el = tabScroller.value;
  if (!el) return;
  const active = el.querySelector('.tab.active');
  if (active) {
    const elLeft = el.scrollLeft;
    const elRight = elLeft + el.clientWidth;
    const aLeft = active.offsetLeft;
    const aRight = aLeft + active.offsetWidth;
    if (aLeft < elLeft) el.scrollTo({ left: aLeft - 8, behavior: 'smooth' });
    else if (aRight > elRight) el.scrollTo({ left: aRight - el.clientWidth + 8, behavior: 'smooth' });
  }
  updateTabScroll();
}
watch([tabs, view], () => { nextTick(ensureActiveTabVisible); });

// v1.18.50：标签右键菜单（刷新 / 关闭其他 / 全部关闭）
const tabMenu = ref({ show: false, x: 0, y: 0, view: null });
function openTabMenu(e, tab) {
  // 简单防溢出：贴右/贴边时把菜单往内收
  const mx = Math.min(e.clientX, window.innerWidth - 130);
  const my = Math.min(e.clientY, window.innerHeight - 130);
  tabMenu.value = { show: true, x: Math.max(8, mx), y: Math.max(8, my), view: tab.view };
}
function closeTabMenu() { tabMenu.value.show = false; }
function refreshTab() {
  closeTabMenu();
  if (currentUser.value) loadForView(view.value);
}
function closeOtherTabs() {
  const keep = tabMenu.value.view;
  closeTabMenu();
  tabs.value = tabs.value.filter((t) => t.view === keep);
  view.value = keep;
}
function closeAllTabs() {
  closeTabMenu();
  tabs.value = [];
  view.value = firstMenu();
}

// 回访打分权限：需「问题回访」功能权限，且为「具备回访全部权限 / 登记人本人 / 老数据（无 createdBy）」
const canRate = computed(() => {
  if (!detail.value || !can('issue.rate')) return false;
  if (can('issue.rateAll')) return true;
  const cb = detail.value.createdBy;
  if (!cb) return true;
  return cb === currentUser.value?.username;
});

// 主题：light（默认，浅色侧栏/顶栏，现代 SaaS 观感）/ dark（深色侧栏/顶栏）
const THEME_KEY = 'issue_tracker_theme';
const theme = ref(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light');
function applyTheme(t) {
  theme.value = t;
  localStorage.setItem(THEME_KEY, t);
  document.documentElement.setAttribute('data-theme', t);
}
applyTheme(theme.value);

function toggleTheme() { applyTheme(theme.value === 'dark' ? 'light' : 'dark'); }

// v1.18.68：主题色（accent）—— 6 种可选主色，data-accent 驱动 --primary 全局生效
//（导航高亮 / 激活标签细条 / 主按钮 / logo / 焦点圈等），与深浅主题正交组合。
const ACCENT_KEY = 'issue_tracker_accent';
const ACCENTS = [
  { key: 'blue',   label: '科技蓝', color: '#2563eb' },
  { key: 'teal',   label: '青碧',   color: '#0d9488' },
  { key: 'green',  label: '翡翠绿', color: '#16a34a' },
  { key: 'violet', label: '典雅紫', color: '#7c3aed' },
  { key: 'rose',   label: '玫红',   color: '#e11d48' },
  { key: 'orange', label: '暖橙',   color: '#ea580c' },
];
const accent = ref(ACCENTS.some(a => a.key === localStorage.getItem(ACCENT_KEY)) ? localStorage.getItem(ACCENT_KEY) : 'blue');
const accentOpen = ref(false);
function applyAccent(a) {
  accent.value = a;
  localStorage.setItem(ACCENT_KEY, a);
  document.documentElement.setAttribute('data-accent', a);
}
function setAccent(a) { applyAccent(a); accentOpen.value = false; }
applyAccent(accent.value);
const accentLabel = computed(() => ACCENTS.find(a => a.key === accent.value)?.label || '主题色');

function applyName(name) {
  if (name) {
    appName.value = name;
    document.title = name;
  }
}

async function loadConfig() {
  try {
    const c = await api.getConfig();
    applyName(c.appName);
    if (Array.isArray(c.roles) && c.roles.length) roles.value = c.roles;
    if (c.permissions) permissions.value = c.permissions;
  } catch { /* 使用默认名称与默认权限 */ }
}

// 导出需带上当前筛选与排序，保持与列表一致
const exportParams = computed(() => ({ ...filters.value, sort: sort.value.by, order: sort.value.order }));

async function load() {
  const params = { ...filters.value, sort: sort.value.by, order: sort.value.order, page: page.value, pageSize: pageSize.value };
  if (recycle.value) params.deleted = 1;   // 回收站视图：仅查已删除记录
  list.value = await api.list(params);
  selected.value = [];   // 列表刷新后清空勾选，避免对不可见记录误操作
}
// 驾驶舱数据：失败时兜底为空，避免白屏
async function loadDashboard() {
  try {
    dash.value = await api.dashboard();
  } catch {
    dash.value = null;
  }
}
// 按当前菜单加载数据（驾驶舱 / 问题登记）
function loadForView(v) {
  if (v === 'dashboard') loadDashboard();
  else if (v === 'issues') load();
}
function onFilter(f) { filters.value = f; page.value = 1; load(); }
// 回收站切换：进入/退出回收站视图（导出不受影响，始终导正常数据）
function onToggleRecycle() {
  recycle.value = !recycle.value;
  page.value = 1;
  load();
}
function onSort(s) { sort.value = s; page.value = 1; load(); }
function openCreate() { editing.value = null; showForm.value = true; }
function openEdit(row) { editing.value = row; showForm.value = true; }
function openDetail(row) { detail.value = row; }
// v1.18.22：从问题列表「引用」按钮打开「引用到聊天」弹框
function openCite(row) { citeProblem.value = row; showCite.value = true; }
// v1.18.22：聊天气泡里点击「问题引用」卡片 → 切到问题登记视图并打开该问题详情；
// App 层用 canView('issues') 做权限判断（无权限时卡片在 Chat 内已不可点）。
async function openIssueFromChat(id) {
  if (!canView('issues')) return;
  openTab('issues');
  const k = groupKeyOf('issues');
  if (k) expandedGroups.value = new Set([...expandedGroups.value, k]);
  try {
    const rec = await api.get(id);
    detail.value = rec;
  } catch (e) {
    alert(e.message || '打开问题失败');
  }
}
function editFromDetail(row) { detail.value = null; openEdit(row); }
function deleteFromDetail(row) { detail.value = null; onDelete(row); }

// v1.18.38：顶栏未读消息跑马灯点击 → 进入聊天视图（并展开聊天所在侧栏分组，与 openIssueFromChat 同款）
function goChat() {
  openTab('chat');
  const k = groupKeyOf('chat');
  if (k) expandedGroups.value = new Set([...expandedGroups.value, k]);
}
// 回访打分后刷新：更新抽屉内记录并重载列表/统计/趋势
function refreshDetail(updated) {
  if (updated && updated.id != null) detail.value = updated;
  load();
}
async function onSubmit({ data, files = [] }) {
  try {
    let created = null;
    if (editing.value) {
      await api.update(editing.value.id, data);
    } else {
      created = await api.create(data);
      // 新建态：表单内拖入/选取的附件在问题落库后一并上传
      for (const f of files) {
        try { await api.uploadAttachment(created.id, f); } catch (err) { alert('附件上传失败：' + (err.message || '')); }
      }
    }
    showForm.value = false;
    await load();
    // 若详情抽屉开着，用最新数据刷新它
    if (detail.value) {
      const id = (created && created.id) || detail.value.id;
      const fresh = (list.value.rows || []).find((r) => String(r.id) === String(id));
      detail.value = fresh || detail.value;
    }
  } catch (e) {
    alert(e.message || '保存失败');
  }
}
async function onDelete(row) {
  if (!confirm(`确认删除「${row.title}」？删除后可在回收站中恢复。`)) return;
  try {
    await api.remove(row.id);
    await load();
  } catch (e) {
    alert(e.message || '删除失败');
  }
}
// 回收站：恢复（软删 → 正常列表）
async function onRestore(row) {
  try {
    await api.restoreProblem(row.id);
    await load();
  } catch (e) {
    alert(e.message || '恢复失败');
  }
}
// 回收站：彻底删除（真删 + 清理附件，不可恢复，需二次确认）
async function onHardDelete(row) {
  if (!confirm(`彻底删除「${row.title}」？\n该操作不可恢复，附件文件也会一并清理，确定继续？`)) return;
  try {
    await api.hardDeleteProblem(row.id);
    await load();
  } catch (e) {
    alert(e.message || '彻底删除失败');
  }
}
function changePage(p) { page.value = p; load(); }
function changePageSize(n) {
  pageSize.value = n;
  localStorage.setItem('issue_tracker_pageSize', String(n));
  page.value = 1;
  load();
}

// ---- 批量操作 ----
function toggleSelect(id) {
  const set = new Set(selected.value.map(String));
  const key = String(id);
  if (set.has(key)) set.delete(key); else set.add(key);
  selected.value = [...set];
}
function toggleSelectAll(ids) { selected.value = ids.map(String); }
function clearSelection() { selected.value = []; bulkStatus.value = ''; }

async function applyBulkStatus() {
  if (!selected.value.length || !bulkStatus.value) return;
  if (!confirm(`确认把选中的 ${selected.value.length} 条问题状态改为「${bulkStatus.value}」？`)) return;
  try {
    await api.bulkStatus(selected.value, bulkStatus.value);
    bulkStatus.value = '';
    await load();
  } catch (e) {
    alert(e.message || '批量修改失败');
  }
}
async function applyBulkDelete() {
  if (!selected.value.length) return;
  if (!confirm(`确认删除选中的 ${selected.value.length} 条问题？删除后可在回收站中恢复或彻底删除。`)) return;
  try {
    const r = await api.bulkDelete(selected.value);
    await load();
    alert(`已删除 ${r.deleted} 条，已移入回收站`);
  } catch (e) {
    alert(e.message || '批量删除失败');
  }
}

// 登录/刷新后定位到「上次所在且仍有权限」的菜单
function applyInitialView() {
  const target = savedView();
  const changed = view.value !== target;
  openTab(target);
  // 侧栏分组（v1.18.19）：默认展开「含当前视图的组」（不做持久化；展开集合整体重置）
  expandedGroups.value = new Set([groupKeyOf(target)].filter(Boolean));
  // 目标与当前一致时 watch 不触发，需手动加载，避免刷新后内容空白
  if (!changed) loadForView(target);
}

function onLoggedIn({ token, user, org, orgs: orgList }) {
  setToken(token);
  resetSessionExpired();   // 重登录清空「失效」信号，避免上一次会话的失效状态串到新会话
  currentUser.value = user;
  currentOrg.value = org || null;
  orgs.value = Array.isArray(orgList) ? orgList : [];
  showLogin.value = false;
  applyInitialView();
  refreshUnread();
  startUnreadPolling();
  // 聊天未读与轮询：登录后并行启动（v1.16）
  refreshChatUnread();
  startChatPolling();
}

// 切换机构：后端按目标机构重新签发 token 与本机构内角色；
// 机构一变，权限、系统名称与全部机构内数据都随之改变 —— 因此全部重载。
async function onSwitchOrg(orgId) {
  if (orgId == null) return;
  if (currentOrg.value && String(currentOrg.value.id) === String(orgId)) return;
  switchingOrg.value = true;
  try {
    const r = await api.switchOrg(orgId);
    // v1.18.11：切机构=换身份，整页刷新保证所有视图/组件/轮询全部按新机构重载
    // （loadForView 只覆盖 dashboard/issues，用户管理/审计/设置/机构管理/聊天等组件视图靠重挂载自加载，
    //   就地重置的历史方案存在遗漏 —— 切换成功后直接 reload，由 boot() 全量重跑，savedView 保证回到原菜单）。
    setToken(r.token);
    location.reload();
  } catch (e) {
    alert(e.message || '切换机构失败');
  } finally {
    switchingOrg.value = false;
  }
}

// 机构管理页改动后刷新「可访问机构列表」（改名 / 停用 / 删除会影响切换器）
async function refreshOrgs() {
  try {
    const r = await api.me();
    orgs.value = Array.isArray(r.orgs) ? r.orgs : [];
    if (r.org) currentOrg.value = r.org;
  } catch { /* 忽略：下次登录或刷新时重新拉取 */ }
}

function logout() {
  clearToken();
  localStorage.removeItem(VIEW_KEY);
  stopUnreadPolling();
  clearUnread();
  stopChatPolling();
  clearChatUnread();
  currentUser.value = null;
  currentOrg.value = null;
  orgs.value = [];
  showLogin.value = true;
}

async function boot() {
  await loadConfig();
  if (!getToken()) { showLogin.value = true; return; }
  try {
    const { user, org, orgs: orgList } = await api.me();
    currentUser.value = user;
    currentOrg.value = org || null;
    orgs.value = Array.isArray(orgList) ? orgList : [];
    applyInitialView();
    refreshUnread();
    startUnreadPolling();
    // 聊天未读与轮询：已登录态刷新页面后恢复（v1.16）
    refreshChatUnread();
    startChatPolling();
  } catch {
    clearToken();
    showLogin.value = true;
  }
}
// 切换菜单：持久化当前视图 + 按需刷新数据
watch(view, (v) => {
  localStorage.setItem(VIEW_KEY, v);
  if (currentUser.value) loadForView(v);
});

// 权限变更后，若当前视图已不可用，则回到第一个可用菜单
watch(myPerms, () => {
  if (currentUser.value && !canView(view.value)) openTab(firstMenu());
});

onMounted(() => {
  boot();
  // v1.18.50：窗口尺寸变化时刷新标签条左右滚动按钮显隐
  window.addEventListener('resize', updateTabScroll);
  nextTick(updateTabScroll);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateTabScroll);
});

// v1.18.48：登录失效（api.js 收到「带 token 的 401」）后自动退到登录界面。
// 监听到信号即停止全部轮询并清空登录态；不清除 VIEW_KEY，重登录后回到原菜单。
// 信号为「置位一次」语义（ref false→true 才触发），多请求并发 401 只退一次。
watch(sessionExpired, (fired) => {
  if (!fired || !currentUser.value) return;
  resetSessionExpired();
  stopUnreadPolling();
  clearUnread();
  stopChatPolling();
  clearChatUnread();
  currentUser.value = null;
  currentOrg.value = null;
  orgs.value = [];
  showLogin.value = true;
});
</script>

<template>
  <Login v-if="showLogin" @loggedIn="onLoggedIn" data-session-expired="v1.18.48-session-expired-redirect" />

  <div class="layout" v-else>
    <!-- v1.18.50 框架改版：整体为「左 / 上 / 下」三区（grid-template-areas 见 styles.css 的 .layout）——
         左：全高侧栏（品牌移到侧栏顶部）；上：48px 顶条 = 蓝底标签条 + 右侧控制区，从侧栏右缘起；
         下：内容区。
         右侧控制区从左到右：机构切换器 + 未读消息提示（v1.18.38）+ 主题按钮 + 用户名 + 修改密码 / 退出。
         机构切换器自内容区页眉（.app-head，已移除）迁来，showOrgBar 逻辑沿用。 -->
    <header class="topbar">
      <!-- v1.18.50：多标签页（Sheet Tabs）—— 点击左侧菜单新增标签，切换标签不重新初始化已打开界面；
           显示不下时通过左右按钮横向滚动；右键标签弹出 刷新/关闭其他/全部关闭。 -->
      <div v-if="tabs.length" class="tab-bar" data-tabs-version="v1.18.50-tabs-keepalive">
        <button v-show="canScrollLeft" class="tab-scroll" title="向左滚动标签" @click="scrollTabs(-1)">‹</button>
        <div ref="tabScroller" class="tab-scroller" @scroll="updateTabScroll">
          <div
            v-for="tab in tabs"
            :key="tab.view"
            class="tab"
            :class="{ active: view === tab.view }"
            @click="openTab(tab.view)"
            @contextmenu.prevent="openTabMenu($event, tab)"
          >
            <span class="tab-title">{{ tab.title }}</span>
            <button class="tab-close" title="关闭" @click.stop="closeTab(tab.view)">×</button>
          </div>
        </div>
        <button v-show="canScrollRight" class="tab-scroll" title="向右滚动标签" @click="scrollTabs(1)">›</button>
      </div>

      <div class="topbar-right">
        <OrgSwitcher
          v-if="showOrgBar"
          :current="currentOrg"
          :orgs="orgs"
          :switching="switchingOrg"
          :can-switch="canSwitchOrg"
          @switch="onSwitchOrg"
        />
        <!-- v1.18.38：未读消息跑马灯 —— 有未读聊天消息时提示，点击进入聊天；放在右侧控制区，不插入标签条中部 -->
        <button v-if="chatUnread > 0" class="unread-marquee" title="点击进入聊天" @click="goChat">
          <span class="um-ico">📢</span>
          <span class="um-viewport"><span class="um-track">您有 {{ chatUnread }} 条未读消息，点击进入聊天查看</span></span>
        </button>
        <button class="theme-btn" :title="theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'" @click="toggleTheme">
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M5.8 5.8 4.3 4.3M19.7 19.7l-1.5-1.5M18.2 5.8l1.5-1.5M4.3 19.7l1.5-1.5" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8a8.6 8.6 0 1 0 10.6 10.6z" />
          </svg>
        </button>
        <!-- v1.18.68：主题色取色器 —— 6 种主色即时全局切换（与深/浅主题正交组合） -->
        <div class="accent-wrap">
          <button class="theme-btn" :title="accentLabel" @click="accentOpen = !accentOpen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 21a9 9 0 1 1 9-9c0 2.2-1.8 3.2-3 3.2h-1.5c-1.1 0-2 .9-2 2 0 .5.2.9.4 1.3.3.4.5.8.5 1.2 0 .9-.7 1.3-1.4 1.3z" />
              <circle cx="7.6" cy="10.6" r="1.1" fill="currentColor" stroke="none" />
              <circle cx="12" cy="7.4" r="1.1" fill="currentColor" stroke="none" />
              <circle cx="16.4" cy="10.6" r="1.1" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <div v-if="accentOpen" class="accent-mask" @click="accentOpen = false"></div>
          <div v-if="accentOpen" class="accent-pop">
            <span class="accent-pop-title">主题色</span>
            <button v-for="a in ACCENTS" :key="a.key" class="accent-dot" :class="{ on: accent === a.key }" :style="{ background: a.color }" :title="a.label" @click="setAccent(a.key)"></button>
          </div>
        </div>
        <span class="topbar-sep" aria-hidden="true"></span>
        <span class="topbar-user" :title="roleLabel(currentUser?.role)">{{ currentUser?.name || currentUser?.username }}</span>
        <button class="topbar-btn" @click="showPwd = true">修改密码</button>
        <button class="topbar-btn" @click="logout">退出</button>
      </div>
    </header>

    <!-- 左：全高侧栏（v1.18.50 框架改版）—— 品牌移到侧栏顶部（多机构时显示当前机构名，
         与右侧切换器同源；单机构显示系统名称）；下方为分组折叠导航：
         组头（图标 + 组名 + chevron）点击展开/收起，子项左对齐，当前项高亮 + 左侧主色强调条。 -->
    <aside class="sidebar">
      <div class="side-brand">
        <span class="logo">信</span>
        <span class="side-brand-title" :title="brandName">{{ brandName }}</span>
      </div>
      <nav class="nav">
        <div v-for="g in navGroups" :key="g.key" class="nav-group">
          <button
            class="nav-group-head"
            :class="{ open: expandedGroups.has(g.key) }"
            :aria-expanded="expandedGroups.has(g.key) ? 'true' : 'false'"
            @click="toggleGroup(g.key)"
          >
            <span class="ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" v-html="ICONS[g.icon]"></svg>
            </span>
            <span class="nav-group-label">{{ g.label }}</span>
            <svg class="nav-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 9.5l6 6 6-6" />
            </svg>
          </button>
          <div v-show="expandedGroups.has(g.key)" class="nav-sub">
            <button
              v-for="it in g.items"
              :key="it.key"
              class="nav-item"
              :class="{ active: view === it.key, 'has-unread': it.badge && it.badge() > 0 }"
              @click="openTab(it.key)"
            >
              <span class="ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" v-html="ICONS[it.icon]"></svg>
              </span>{{ it.label }}
              <span v-if="it.badge && it.badge() > 0" class="nav-badge">{{ it.badge() > 99 ? '99+' : it.badge() }}</span>
            </button>
          </div>
        </div>
      </nav>
      <!-- v1.18.69：页脚（版本 + 版权）自内容区迁入侧栏底部——给侧栏一个视觉终点，
           分组自顶部紧凑排列时底部不再悬空；版本号常驻可见，便于截图定位反馈问题。
           .nav 为 flex:1 撑满剩余高度，本品 naturally 落底（见 styles.css .side-foot）。 -->
      <footer class="side-foot">
        <span class="copy">© 2026 软件问题登记系统</span>
        <span class="ver">{{ APP_VERSION }}</span>
      </footer>
    </aside>

    <main class="content">
      <!-- v1.18.19：原内容区页眉（.app-head 机构条）已移除 —— 机构切换器迁往顶条（避免双份）；
           showOrgBar / canSwitchOrg / switchingOrg 与切机构逻辑（v1.18.11 整页刷新）零改动。
           v1.18.50：标签条已上移到顶条（.topbar 内），内容区只保留各视图 section。 -->

      <!-- v1.18.50：标签右键菜单（刷新 / 关闭其他 / 全部关闭） -->
      <teleport to="body">
        <div v-if="tabMenu.show">
          <div class="tab-menu-mask" @click="closeTabMenu" @contextmenu.prevent="closeTabMenu"></div>
          <div class="tab-menu" :style="{ left: tabMenu.x + 'px', top: tabMenu.y + 'px' }" @click.stop>
            <button class="tab-menu-item" @click="refreshTab">刷新</button>
            <button class="tab-menu-item" @click="closeOtherTabs">关闭其他</button>
            <button class="tab-menu-item" @click="closeAllTabs">全部关闭</button>
          </div>
        </div>
      </teleport>

      <section v-show="view === 'issues'">
        <header class="page-head">
          <div>
            <h1>问题登记</h1>
            <p class="sub">登记并跟踪各科室报来的软件问题</p>
          </div>
          <div class="actions">
            <button v-if="can('issue.create')" class="primary" @click="openCreate">+ 登记问题</button>
            <button v-if="can('issue.create')" @click="showImport = true">批量导入</button>
            <ExportButtons v-if="can('issue.export')" :filters="exportParams" />
          </div>
        </header>
        <FilterBar :filters="filters" :recycle="recycle" @filter="onFilter" @search="onFilter" @toggle-recycle="onToggleRecycle" />

        <div v-if="selected.length && canBulk" class="bulk-bar">
          <span class="bulk-count">已选 <b>{{ selected.length }}</b> 条</span>
          <div class="bulk-actions">
            <template v-if="can('issue.bulkStatus')">
              <label class="bulk-status">状态改为
                <select v-model="bulkStatus">
                  <option value="">请选择</option>
                  <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
                </select>
              </label>
              <button class="small primary" :disabled="!bulkStatus" @click="applyBulkStatus">应用</button>
            </template>
            <button v-if="can('issue.bulkDelete')" class="small danger" @click="applyBulkDelete">批量删除</button>
            <button class="small" @click="clearSelection">取消选择</button>
          </div>
        </div>

        <ProblemList
          :rows="list.rows"
          :total="list.total"
          :page="page"
          :page-size="pageSize"
          :can-delete="can('issue.delete')"
          :can-edit="can('issue.edit')"
          :can-audit="can('issue.audit')"
          :can-cite="canView('issues')"
          :selectable="canBulk && !recycle"
          :recycle="recycle"
          :sort-by="sort.by"
          :sort-order="sort.order"
          :selected="selected"
          @sort="onSort"
          @view="openDetail"
          @cite="openCite"
          @edit="openEdit"
          @delete="onDelete"
          @restore="onRestore"
          @hard-delete="onHardDelete"
          @audited="load"
          @page="changePage"
          @page-size="changePageSize"
          @toggle="toggleSelect"
          @toggle-all="toggleSelectAll"
        />
      </section>

      <section v-show="view === 'dashboard'">
        <header class="page-head">
          <div>
            <h1>数据驾驶舱</h1>
            <p class="sub">多维度实时统计 · 状态/类型/严重程度/科室/系统/人员全景</p>
          </div>
        </header>
        <Cockpit :data="dash" />
      </section>

      <NotificationCenter
        v-show="view === 'notification'"
        :can-send="can('notification.send')"
        :can-broadcast="can('notification.broadcast')"
      />
      <DutyRoster v-show="view === 'schedule'" :can-manage="can('schedule.manage')" :can-platform-admin="currentUser?.platformAdmin === true" />
      <Audited v-show="view === 'audited'" :can-audit="can('issue.audit')" @view="openDetail" />
      <KnowledgeBase v-show="view === 'kb'" />
      <FileManage
        v-show="view === 'files'"
        :can-upload="can('file.upload')"
        :can-delete="can('file.delete')"
        :can-platform-admin="currentUser?.platformAdmin === true"
      />
      <!-- v1.18.82：业务服务管理 -->
      <ServiceManage v-show="view === 'svcmanage'" :can-manage="can('service.manage')" />
      <Timesheet v-show="view === 'timesheet'" @go-config="openTab('tsconfig')" />
      <TimesheetSettings v-show="view === 'tsconfig'" />
      <!-- v1.18.51：AI 技能五模块（自 HIS.OPS 移植） -->
      <WxpDraftQuery v-show="view === 'wxpdraft'" />
      <TfsQuery v-show="view === 'tfsquery'" />
      <PmisQuery v-show="view === 'pmisquery'" />
      <ChangeRequest v-show="view === 'changerequest'" />
      <GoLiveConfirm v-show="view === 'golive'" />
      <Chat v-show="view === 'chat'" :current-user="currentUser" :can-use="can('chat.use')" :can-view-issues="canView('issues')" @open-issue="openIssueFromChat" />
      <UserManage
        v-if="canMenu('users')"
        v-show="view === 'users'"
        :current-org="currentOrg"
        :can-platform-admin="currentUser?.platformAdmin === true"
        @updated="loadConfig"
      />
      <AuditLogPanel v-if="canMenu('audit')" v-show="view === 'audit'" />
      <Settings v-if="canMenu('settings')" v-show="view === 'settings'" :can-edit="can('settings.edit')" @updated="applyName" />
      <OrgManage
        v-if="currentUser?.platformAdmin"
        v-show="view === 'orgs'"
        :current-org-id="currentOrg?.id"
        @changed="refreshOrgs"
      />

    </main>

    <NotificationBell
      :can-send="can('notification.send')"
      :can-broadcast="can('notification.broadcast')"
      @open-center="openTab('notification')"
    />

    <ProblemForm
      v-if="showForm"
      :initial="editing"
      :can-delete="can('issue.delete')"
      :current-user="currentUser"
      @submit="onSubmit"
      @close="showForm = false"
      @refresh="load"
    />
    <ProblemDetail
      v-if="detail"
      :problem="detail"
      :can-delete="can('issue.delete')"
      :can-edit="can('issue.edit')"
      :can-rate="canRate"
      @close="detail = null"
      @edit="editFromDetail"
      @delete="deleteFromDetail"
      @refresh="refreshDetail"
    />
    <ProblemImport v-if="showImport" @close="showImport = false" @imported="load" />
    <ChangePassword v-if="showPwd" @close="showPwd = false" />

    <!-- v1.18.22：引用问题到聊天的弹框（v1.18.24 传入当前用户，供会话显示名与回读校验用） -->
    <CiteToChat
      v-if="showCite"
      :problem="citeProblem"
      :current-user="currentUser"
      @close="showCite = false"
      @sent="showCite = false"
    />
  </div>
</template>
