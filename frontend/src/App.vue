<script setup>
import { ref, computed, onMounted, watch, watchEffect } from 'vue';
import { api, getToken, setToken, clearToken, STATUSES, DEFAULT_PERMISSIONS, MENU_ORDER, BUILTIN_ROLES, DENY_ALL } from './api.js';
import FilterBar from './components/FilterBar.vue';
import ProblemList from './components/ProblemList.vue';
import ProblemForm from './components/ProblemForm.vue';
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
import Chat from './components/Chat.vue';
import CiteToChat from './components/CiteToChat.vue';
import OrgSwitcher from './components/OrgSwitcher.vue';
import OrgManage from './components/OrgManage.vue';
import Timesheet from './components/Timesheet.vue';
import TimesheetSettings from './components/TimesheetSettings.vue';
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
// 单机构 / 登录页仍显示机构级「系统名称」（appName）。
const brandName = computed(() =>
  (showOrgBar.value && orgs.value.length > 1 && currentOrg.value?.name)
    ? currentOrg.value.name
    : appName.value
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
  schedule:     { label: '值班表',     icon: 'schedule' },
  chat:         { label: '聊天',       icon: 'chat',    badge: () => chatUnread.value },
  notification: { label: '消息通知',   icon: 'bell',    badge: () => unread.value },
  users:        { label: '用户管理',   icon: 'users' },
  audit:        { label: '操作日志',   icon: 'audit' },
  settings:     { label: '系统设置',   icon: 'settings' },
  orgs:         { label: '机构管理',   icon: 'orgs' },
  timesheet:    { label: '工时登记',   icon: 'timesheet' },
  tsconfig:     { label: '工时配置',   icon: 'tsconfig' },
};
const NAV_GROUPS = [
  { key: 'work',  label: '业务工作', icon: 'group-work',  items: ['dashboard', 'issues', 'audited', 'kb', 'schedule'] },
  { key: 'comms', label: '沟通协作', icon: 'group-comms', items: ['chat', 'notification'] },
  { key: 'impl',  label: '实施协同', icon: 'group-impl',  items: ['timesheet'] },
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
  schedule: '<rect x="3.5" y="4.5" width="17" height="16" rx="2.5" /><path d="M8 2.8v3.4M16 2.8v3.4M3.5 9.6h17" /><path d="M7.8 13.5h2.4M13.8 13.5h2.4M7.8 17h2.4" />',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20l1.1-4.9A8.5 8.5 0 1 1 21 11.5z" />',
  bell: '<path d="M18 8.5a6 6 0 0 0-12 0c0 6-2.2 7.5-2.2 7.5h16.4S18 14.5 18 8.5z" /><path d="M13.7 20a2 2 0 0 1-3.4 0" />',
  users: '<circle cx="9.5" cy="8" r="3.3" /><path d="M3.6 19.6c0-3.1 2.6-5.2 5.9-5.2s5.9 2.1 5.9 5.2" /><path d="M16.6 5.6a3 3 0 0 1 0 5.5M18.2 14.8c1.9.6 3.1 2.2 3.1 4.1" />',
  audit: '<path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" /><path d="M3.6 4.6V9h4.4" /><path d="M12 8.2V12l3 1.9" />',
  settings: '<circle cx="12" cy="12" r="3.4" /><path d="M12 2.6l1.3 2.6 2.8-.7.7 2.8 2.6 1.3-1.3 2.6 1.3 2.6-2.6 1.3-.7 2.8-2.8-.7L12 21.4l-1.3-2.6-2.8.7-.7-2.8-2.6-1.3L5.9 12 4.6 9.4l2.6-1.3.7-2.8 2.8.7z" />',
  orgs: '<path d="M4 21V6.5L12 3l8 3.5V21" /><path d="M4 21h16M9.5 21v-4.6h5V21" /><path d="M8.6 9.4h1.6M13.8 9.4h1.6M8.6 12.8h1.6M13.8 12.8h1.6" />',
  timesheet: '<circle cx="12" cy="12" r="8.5" /><path d="M12 7V12l3.4 2.2" /><path d="M8.2 3.9l.8 1.6M15.8 3.9l-.8 1.6" />',
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

// 回访打分权限：需「问题回访」功能权限，且为「具备回访全部权限 / 登记人本人 / 老数据（无 createdBy）」
const canRate = computed(() => {
  if (!detail.value || !can('issue.rate')) return false;
  if (can('issue.rateAll')) return true;
  const cb = detail.value.createdBy;
  if (!cb) return true;
  return cb === currentUser.value?.username;
});

// 主题：dark（默认，深色侧栏）/ light（浅色侧栏）
const THEME_KEY = 'issue_tracker_theme';
const theme = ref(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
function applyTheme(t) {
  theme.value = t;
  localStorage.setItem(THEME_KEY, t);
  document.documentElement.setAttribute('data-theme', t);
}
applyTheme(theme.value);

function toggleTheme() { applyTheme(theme.value === 'dark' ? 'light' : 'dark'); }

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
  view.value = 'issues';
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
  view.value = 'chat';
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
  view.value = target;
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
  if (currentUser.value && !canView(view.value)) view.value = firstMenu();
});

onMounted(boot);

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
  <Login v-if="showLogin" :app-name="appName" @loggedIn="onLoggedIn" data-session-expired="v1.18.48-session-expired-redirect" />

  <div class="layout" v-else>
    <!-- 顶栏（v1.18.19；v1.18.20 品牌语义调整）：左侧品牌名——多机构时显示**当前机构名**
         （与右侧切换器同源，避免「品牌显示默认机构名、切换器显示当前机构」对不上），
         单机构/登录页显示机构级「系统名称」。
         右侧从左到右：机构切换器 + 主题按钮 + 分隔线 + 用户名 + 修改密码 / 退出。
         机构切换器自内容区页眉（.app-head，已移除）迁来，showOrgBar 逻辑沿用；
         顶栏在两种主题下都是深色（沿用侧栏深色配色），OrgSwitcher 的两态配色已按深色宿主调整。 -->
    <header class="topbar">
      <div class="topbar-brand">
        <span class="logo">信</span>
        <span class="topbar-title" :title="brandName">{{ brandName }}</span>
      </div>
      <!-- v1.18.38：未读消息跑马灯 —— 有未读聊天消息时在顶栏中部滚动提示，点击进入聊天 -->
      <button v-if="chatUnread > 0" class="unread-marquee" title="点击进入聊天" @click="goChat">
        <span class="um-ico">📢</span>
        <span class="um-viewport"><span class="um-track">您有 {{ chatUnread }} 条未读消息，点击进入聊天查看</span></span>
      </button>
      <div class="topbar-right">
        <OrgSwitcher
          v-if="showOrgBar"
          :current="currentOrg"
          :orgs="orgs"
          :switching="switchingOrg"
          :can-switch="canSwitchOrg"
          @switch="onSwitchOrg"
        />
        <button class="theme-btn" :title="theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'" @click="toggleTheme">
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M5.8 5.8 4.3 4.3M19.7 19.7l-1.5-1.5M18.2 5.8l1.5-1.5M4.3 19.7l1.5-1.5" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8a8.6 8.6 0 1 0 10.6 10.6z" />
          </svg>
        </button>
        <span class="topbar-sep" aria-hidden="true"></span>
        <span class="topbar-user" :title="roleLabel(currentUser?.role)">{{ currentUser?.name || currentUser?.username }}</span>
        <button class="topbar-btn" @click="showPwd = true">修改密码</button>
        <button class="topbar-btn" @click="logout">退出</button>
      </div>
    </header>

    <!-- 侧栏分组折叠导航（v1.18.19）：组头（图标 + 组名 + chevron）点击展开/收起；
         子项左对齐（图标 + 名称缩进），当前项高亮 + 左侧主色强调条（inset 3px，零位移）。 -->
    <aside class="sidebar">
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
              @click="view = it.key"
            >
              <span class="ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" v-html="ICONS[it.icon]"></svg>
              </span>{{ it.label }}
              <span v-if="it.badge && it.badge() > 0" class="nav-badge">{{ it.badge() > 99 ? '99+' : it.badge() }}</span>
            </button>
          </div>
        </div>
      </nav>
    </aside>

    <main class="content">
      <!-- v1.18.19：原内容区页眉（.app-head 机构条）已移除 —— 机构切换器迁往顶栏（避免双份）；
           showOrgBar / canSwitchOrg / switchingOrg 与切机构逻辑（v1.18.11 整页刷新）零改动。 -->
      <section v-show="view === 'issues'">
        <header class="page-head">
          <div>
            <h1>问题登记</h1>
            <p class="sub">登记并跟踪各科室报来的软件问题</p>
          </div>
          <div class="actions">
            <button v-if="can('issue.create')" class="primary" @click="openCreate">+ 登记问题</button>
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
        v-if="view === 'notification'"
        :can-send="can('notification.send')"
        :can-broadcast="can('notification.broadcast')"
      />
      <DutyRoster v-if="view === 'schedule'" :can-manage="can('schedule.manage')" :can-platform-admin="currentUser?.platformAdmin === true" />
      <Audited v-if="view === 'audited'" :can-audit="can('issue.audit')" @view="openDetail" />
      <KnowledgeBase v-if="view === 'kb'" />
      <Timesheet v-if="view === 'timesheet'" @go-config="view = 'tsconfig'" />
      <TimesheetSettings v-if="view === 'tsconfig'" />
      <Chat v-if="view === 'chat'" :current-user="currentUser" :can-use="can('chat.use')" :can-view-issues="canView('issues')" @open-issue="openIssueFromChat" />
      <UserManage
        v-if="view === 'users' && canMenu('users')"
        :current-org="currentOrg"
        :can-platform-admin="currentUser?.platformAdmin === true"
        @updated="loadConfig"
      />
      <AuditLogPanel v-if="view === 'audit' && canMenu('audit')" />
      <Settings v-if="view === 'settings' && canMenu('settings')" :can-edit="can('settings.edit')" @updated="applyName" />
      <OrgManage
        v-if="view === 'orgs' && currentUser?.platformAdmin"
        :current-org-id="currentOrg?.id"
        @changed="refreshOrgs"
      />

      <!-- v1.18.34：全局页脚（版权信息 + 版本号），位于每个界面内容区底部。
           作为 <main> 的末子节点，仅覆盖内容区宽度（不压左侧深色侧栏）；
           上方 .content 的 padding-bottom:56px 让页脚自然落在右下角浮动铃铛上方，互不遮挡。 -->
      <footer class="app-foot">
        <span class="copy">© 2026 软件问题登记系统 · 版权所有</span>
        <span class="ver">{{ APP_VERSION }}</span>
      </footer>
    </main>

    <NotificationBell
      :can-send="can('notification.send')"
      :can-broadcast="can('notification.broadcast')"
      @open-center="view = 'notification'"
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
