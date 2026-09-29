<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api, PERM_MENUS, PERM_ACTIONS, PERM_MODULES, PLATFORM_MODULES, DEFAULT_PERMISSIONS, BUILTIN_ROLES, isValidRoleKey, defaultRolePermissions } from '../api.js';
import Tabs from './Tabs.vue';

const emit = defineEmits(['updated']);

// 多机构（v1.18）：用户列表是「本机构花名册」；平台管理员可在此指派跨机构管理权限。
const props = defineProps({
  currentOrg: { type: Object, default: null },
  canPlatformAdmin: { type: Boolean, default: false },
});

// sheet 页：用户列表 / 角色与权限（v-show 切换，保留本地编辑状态）
const tabs = [
  { key: 'users', label: '用户列表' },
  { key: 'roles', label: '角色与权限' },
];
const activeTab = ref('users');

const users = ref([]);
const error = ref('');       // 列表 / 配置加载错误
// 联系电话（v1.18.17）：新建弹框选填，随 createUser 提交
const form = ref({ username: '', name: '', password: '', role: 'reporter', userType: 'hospital', phone: '' });

// 用户类型（v1.18.12）：列表上方的本地筛选（全部 / 院方 / 公司）
const typeFilter = ref('all');
// 类型筛选的二级 sheet 页（v1.18.15）：下拉改为标签页，复用 Tabs 组件；过滤逻辑零改动
const typeTabs = [
  { key: 'all', label: '全部' },
  { key: 'hospital', label: '院方用户' },
  { key: 'company', label: '公司用户' },
];
const filteredUsers = computed(() => {
  if (typeFilter.value === 'all') return users.value;
  return users.value.filter((u) => (u.userType || 'hospital') === typeFilter.value);
});
// 公司用户的「归属机构数」（仅平台管理员可拉取 memberships 接口，用于 chip 的 title 提示）
const orgCounts = ref({});

// 在线状态（v1.18.41）：最近 90s 内有过认证请求的账号（后端内存 presence 表）。
// 30s 轮询刷新 —— 用户管理页打开期间前端自身的轮询请求也会持续喂心跳，看到自己恒在线。
const onlineSet = ref(new Set());
let presenceTimer = null;
async function loadPresence() {
  try {
    const d = await api.userPresence();
    onlineSet.value = new Set(d.online || []);
  } catch { /* 静默：在线列随下次轮询自动恢复 */ }
}
const isOnline = (u) => onlineSet.value.has(u.username);

// 最近登录时间（v1.18.44）：登录成功时后端记录（app_user.last_login_at）。
// null/非法值=从未登录，显示「—」；否则格式化 YYYY-MM-DD HH:mm（分钟粒度足够）。
const fmtLastLogin = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 新增用户弹框（状态放组件顶层，避免与 v-show 标签页耦合）
const showCreate = ref(false);
const createError = ref('');

// 改电话弹框（v1.18.17）：草稿副本，错误显示在弹框内；点击遮罩不关闭（项目约定）
const phoneOpen = ref(false);
const phoneUser = ref(null);   // 目标用户（草稿副本）
const phoneDraft = ref('');
const phoneErr = ref('');
const phoneSaving = ref(false);

// 分配机构弹框（v1.18.12，仅平台管理员；针对公司用户的多机构分配）
const assignOpen = ref(false);
const assignUser = ref(null);     // 目标用户（草稿副本，弹框内修改不影响列表）
const assignList = ref([]);       // 现有成员关系 [{orgId, orgName, role, orgActive}]
const assignOrgs = ref([]);       // 全部机构（平台管理员接口 /api/orgs）
const assignAddOrgId = ref('');   // 「添加机构」行选中的机构
const assignAddRole = ref('');    // 「添加机构」行选中的角色
const assignErr = ref('');
const assignSaving = ref(false);

// 动态角色列表（来自 /api/config，可增删改）
const roles = ref(BUILTIN_ROLES.map((r) => ({ ...r })));
// 角色权限（结构化深拷贝，避免直接改到常量）
const perm = ref(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS)));

const permSaving = ref(false);
const permError = ref('');

// 新增角色表单
const newRole = ref({ label: '', key: '' });
const roleError = ref('');

// 权限设置弹框（顶层，独立于 v-show 标签页）：编辑 draft，取消即丢弃
const permRole = ref(null);
const draft = ref(null);
const selModule = ref(PERM_MODULES[0].key);

// 某角色下的用户数
const userCount = computed(() => {
  const m = {};
  for (const u of users.value) m[u.role] = (m[u.role] || 0) + 1;
  return m;
});
function countOf(key) { return userCount.value[key] || 0; }

// 权限表访问器：缺失时用该角色默认权限兜底，避免模板报错
function pOf(key) { return perm.value[key] || defaultRolePermissions(key); }
function ensureRolePerm(key) { if (!perm.value[key]) perm.value[key] = defaultRolePermissions(key); }
function defaultNewUserRole() {
  return roles.value.some((r) => r.key === 'reporter') ? 'reporter' : (roles.value[0]?.key || 'reporter');
}

// 公司用户 chip 的 title：已知归属数时显示「属于 N 个机构」，否则退化为「公司用户」
function typeTitle(u) {
  const n = orgCounts.value[u.id];
  return typeof n === 'number' ? `公司用户，属于 ${n} 个机构` : '公司用户';
}

// 某角色已开功能数（角色列表「权限概览」列）
function permCount(key) {
  const p = pOf(key);
  return PERM_ACTIONS.filter((a) => p.actions && p.actions[a.key] === true).length;
}
// 某模块下的功能项 / 是否真实菜单
function actionsOf(moduleKey) { return PERM_ACTIONS.filter((a) => a.menu === moduleKey); }
function isMenu(moduleKey) { return PERM_MENUS.some((m) => m.key === moduleKey); }
// 当前选中项若是「平台级功能」，则右栏不显示任何可勾选项，只做说明（见 PLATFORM_MODULES）。
const selPlatform = computed(() => PLATFORM_MODULES.find((m) => m.key === selModule.value) || null);
// 左栏 / 右栏标题统一取名：菜单、功能模块、平台级功能三类清单里按 key 查。
function moduleLabel(key) {
  const m = PERM_MODULES.find((x) => x.key === key) || PLATFORM_MODULES.find((x) => x.key === key);
  return m ? m.label : key;
}
// 弹框左栏计数：已开功能/总功能；无功能项显示 —
function moduleCount(moduleKey) {
  const items = actionsOf(moduleKey);
  if (!items.length) return '—';
  const on = items.filter((a) => draft.value && draft.value.actions[a.key] === true).length;
  return `${on}/${items.length}`;
}

async function load() {
  try {
    users.value = await api.listUsers();
    await loadOrgCounts();
  } catch (e) { error.value = e.message; }
}

// 拉取公司用户的机构归属数（仅平台管理员有权限；失败静默 —— title 退化为「公司用户」）
async function loadOrgCounts() {
  if (!props.canPlatformAdmin) return;
  for (const u of users.value.filter((x) => x.userType === 'company')) {
    try {
      const ms = await api.listUserMemberships(u.id);
      orgCounts.value = { ...orgCounts.value, [u.id]: Array.isArray(ms) ? ms.length : 0 };
    } catch { /* 无权限或网络失败：不阻塞列表 */ }
  }
}
async function loadConfig() {
  try {
    const c = await api.getConfig();
    if (Array.isArray(c.roles) && c.roles.length) roles.value = c.roles.map((r) => ({ ...r }));
    if (c.permissions) perm.value = JSON.parse(JSON.stringify(c.permissions));
    // 保证每个角色都有权限条目，并清理已不存在的角色
    for (const r of roles.value) ensureRolePerm(r.key);
    for (const k of Object.keys(perm.value)) {
      if (!roles.value.some((r) => r.key === k)) delete perm.value[k];
    }
    if (!roles.value.some((r) => r.key === form.value.role)) form.value.role = defaultNewUserRole();
  } catch (e) { error.value = e.message; }
}

// 打开 / 关闭「新增用户」弹框
function openCreate() {
  createError.value = '';
  form.value = { username: '', name: '', password: '', role: defaultNewUserRole(), userType: 'hospital', phone: '' };
  showCreate.value = true;
}
function closeCreate() {
  showCreate.value = false;
  createError.value = '';
}

async function create() {
  createError.value = '';
  if (!form.value.username || !form.value.password) { createError.value = '用户名和密码必填'; return; }
  try {
    await api.createUser({ ...form.value });
    form.value = { username: '', name: '', password: '', role: defaultNewUserRole(), userType: 'hospital', phone: '' };
    showCreate.value = false;   // 成功后关闭弹框
    await load();
  } catch (e) {
    createError.value = e.message;   // 后端中文错误显示在弹框内
  }
}

// ---- 改电话弹框（v1.18.17）----
// 草稿副本：phoneUser 是列表行的浅拷贝；保存成功后关弹框 + toast + 刷新列表。
// 后端 404（多机构公司用户 / 跨机构专属账号，由平台管理员管理）或 400 的中文原因原样展示在弹框内。
function openPhone(u) {
  phoneErr.value = '';
  phoneUser.value = { ...u };
  phoneDraft.value = u.phone || '';
  phoneOpen.value = true;
}
function closePhone() {
  phoneOpen.value = false;
  phoneUser.value = null;
  phoneErr.value = '';
}
async function savePhone() {
  if (!phoneUser.value) return;
  phoneErr.value = '';
  const ph = (phoneDraft.value || '').trim();
  if (ph.length > 20) { phoneErr.value = '联系电话过长'; return; }
  phoneSaving.value = true;
  try {
    await api.updateUserPhone(phoneUser.value.id, ph);
    closePhone();
    alert('电话已更新');
    await load();
  } catch (e) {
    phoneErr.value = e.message || '修改失败';   // 弹框不关闭，错误留在弹框内
  } finally {
    phoneSaving.value = false;
  }
}

// 切换用户类型（v1.18.12，仅平台管理员）：院方 ⇄ 公司。后端拒绝（如公司用户仍归属多机构）时展示原因。
async function toggleType(u) {
  const next = u.userType === 'company' ? 'hospital' : 'company';
  const label = next === 'company' ? '公司用户' : '院方用户';
  if (!confirm(`确认把「${u.username}」改为${label}？`)) return;
  try {
    await api.setUserType(u.id, next);
    await load();
  } catch (e) {
    alert(e.message || '修改用户类型失败');
    users.value = users.value.map((x) => ({ ...x }));   // 失败回滚（重建数组让下拉/按钮回到原值）
  }
}

// ---- 分配机构弹框（v1.18.12，公司用户）----
// 草稿副本：assignUser 是列表行的浅拷贝，弹框内改动不影响页面；取消即丢弃。
function openAssign(u) {
  assignErr.value = '';
  assignAddOrgId.value = '';
  assignAddRole.value = defaultNewUserRole();
  assignUser.value = { ...u };
  assignOpen.value = true;
  loadAssign();
}
function closeAssign() {
  assignOpen.value = false;
  assignUser.value = null;
  assignErr.value = '';
}
async function loadAssign() {
  if (!assignUser.value) return;
  assignErr.value = '';
  try {
    const [ms, orgs] = await Promise.all([
      api.listUserMemberships(assignUser.value.id),
      api.listOrgs(),
    ]);
    assignList.value = Array.isArray(ms) ? ms : [];
    assignOrgs.value = Array.isArray(orgs.orgs) ? orgs.orgs : [];
    if (!assignAddRole.value || !roles.value.some((r) => r.key === assignAddRole.value)) {
      assignAddRole.value = defaultNewUserRole();
    }
  } catch (e) {
    assignErr.value = e.message || '加载机构归属失败';
  }
}
// 「添加机构」候选：尚未归属的机构
const assignableOrgs = computed(() =>
  assignOrgs.value.filter((o) => !assignList.value.some((m) => String(m.orgId) === String(o.id)))
);
async function addAssign() {
  assignErr.value = '';
  if (!assignUser.value) return;
  if (!assignAddOrgId.value) { assignErr.value = '请选择要加入的机构'; return; }
  if (!assignAddRole.value) { assignErr.value = '请选择角色'; return; }
  assignSaving.value = true;
  try {
    await api.addUserMembership(assignUser.value.id, { orgId: assignAddOrgId.value, role: assignAddRole.value });
    assignAddOrgId.value = '';
    await loadAssign();
    await load();
  } catch (e) {
    assignErr.value = e.message || '添加失败';   // 后端 400 原样展示在弹框内
  } finally {
    assignSaving.value = false;
  }
}
// 修改该用户在某机构内的角色（接口为幂等 upsert：同 orgId 重复提交即改角色）
async function changeAssignRole(m, role) {
  assignErr.value = '';
  if (!assignUser.value || role === m.role) return;
  assignSaving.value = true;
  try {
    await api.addUserMembership(assignUser.value.id, { orgId: m.orgId, role });
    await loadAssign();
  } catch (e) {
    assignErr.value = e.message || '角色修改失败';
    await loadAssign();   // 失败回滚显示
  } finally {
    assignSaving.value = false;
  }
}
async function removeAssign(m) {
  assignErr.value = '';
  if (!assignUser.value) return;
  if (!confirm(`确认把「${assignUser.value.username}」移出机构「${m.orgName}」？`)) return;
  assignSaving.value = true;
  try {
    await api.removeUserMembership(assignUser.value.id, m.orgId);
    await loadAssign();
    await load();
  } catch (e) {
    assignErr.value = e.message || '移除失败';   // 守卫文案（至少保留一个机构等）展示在弹框内
  } finally {
    assignSaving.value = false;
  }
}
async function resetPwd(u) {
  const p = prompt(`为用户「${u.username}」设置新密码（至少 6 位）`);
  if (!p) return;
  try { await api.resetPassword(u.id, p); alert('密码已重置'); }
  catch (e) { alert(e.message); }
}
async function toggle(u) {
  const act = u.active ? '停用' : '启用';
  if (!confirm(`确认${act}用户「${u.username}」？`)) return;
  try { await api.setUserStatus(u.id, !u.active); await load(); }
  catch (e) { alert(e.message); }
}

// 操作下拉（v1.18.32）：与 v1.18.23 问题登记列表同款（复用全局 .ops-* 样式）。
// 菜单 position:fixed 按按钮 rect 计算，避免被 .table-wrap 的 overflow 裁剪表格底部行的菜单；
// 打开期间滚动/缩放即收起，防止 fixed 坐标失准。
const OPS_MENU_W = 132;
const opsOpenId = ref(null);
const opsPos = ref({ top: 0, left: 0 });
function toggleOps(u, e) {
  if (opsOpenId.value === u.id) { opsOpenId.value = null; return; }
  const rect = e.currentTarget.getBoundingClientRect();
  opsPos.value = {
    top: rect.bottom + 4,
    left: Math.max(8, Math.min(rect.right - OPS_MENU_W, window.innerWidth - OPS_MENU_W - 8)),
  };
  opsOpenId.value = u.id;
}
// 从菜单项发起操作：先收起下拉再执行（打开弹框类操作不与下拉叠加）
function doOp(fn, u) {
  opsOpenId.value = null;
  fn(u);
}
function onDocClickCloseOps() {
  opsOpenId.value = null;   // 菜单内部点击已被 .ops-wrap 的 @click.stop 挡住，不会走到这里
}
function onWinScroll() {
  opsOpenId.value = null;
}
onMounted(() => {
  document.addEventListener('click', onDocClickCloseOps);
  window.addEventListener('scroll', onWinScroll, true);
  window.addEventListener('resize', onWinScroll);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocClickCloseOps);
  window.removeEventListener('scroll', onWinScroll, true);
  window.removeEventListener('resize', onWinScroll);
});

// 指派 / 取消平台管理员（跨机构管理权限，仅平台管理员可操作；后端拒绝取消最后一个）
async function togglePlatformAdmin(u) {
  const act = u.platformAdmin ? '取消' : '设为';
  if (!confirm(`确认${act}平台管理员「${u.username}」？\n平台管理员可查看与管理全部机构，请谨慎授予。`)) return;
  try {
    await api.setUserPlatformAdmin(u.id, !u.platformAdmin);
    await load();
    emit('updated');
  } catch (e) { alert(e.message || '操作失败'); }
}

// 直接切换用户角色（失败回滚显示）
async function changeRole(u, role) {
  if (role === u.role) return;
  try {
    await api.updateUserRole(u.id, role);
    u.role = role;
    await load();
  } catch (e) {
    alert(e.message || '角色修改失败');
    users.value = users.value.map((x) => ({ ...x })); // 重建数组以回滚下拉显示
  }
}

// 角色 key → 中文名（用于「平台管理员的角色是固定的」这段说明文字，v1.18.10）
function roleLabel(key) {
  const r = roles.value.find((x) => x.key === key);
  return (r && r.label) || key || '';
}

// ---- 角色管理 ----
// 由名称生成合法 key（中文名称无法转写，此处置随机合法 key，用户可在输入框自行覆盖）
function genKey() {
  let k;
  do {
    k = 'role_' + Math.random().toString(36).slice(2, 8);
  } while (roles.value.some((r) => r.key === k) || !isValidRoleKey(k));
  return k;
}
function addRole() {
  roleError.value = '';
  const label = (newRole.value.label || '').trim();
  if (!label) { roleError.value = '请填写角色名称'; return; }
  let key = (newRole.value.key || '').trim();
  if (!key) key = genKey();
  if (!isValidRoleKey(key)) { roleError.value = '角色标识不合法：须小写字母开头，含数字/_/-，2~30 位'; return; }
  if (roles.value.some((r) => r.key === key)) { roleError.value = `角色标识『${key}』已存在`; return; }
  if (roles.value.some((r) => r.label === label)) { roleError.value = `角色名称『${label}』已存在`; return; }
  roles.value = [...roles.value, { key, label: label.slice(0, 24), builtin: false }];
  ensureRolePerm(key);
  newRole.value = { label: '', key: '' };
}
function renameRole(role) {
  const v = prompt(`修改角色名称（当前：${role.label}）`, role.label);
  if (v === null) return;
  const label = String(v).trim();
  if (!label) { alert('角色名称不能为空'); return; }
  if (roles.value.some((r) => r.key !== role.key && r.label === label)) { alert(`角色名称『${label}』已存在`); return; }
  role.label = label.slice(0, 24);
}
function removeRole(role) {
  if (role.builtin) { alert('内置角色不可删除，只可改名'); return; }
  const n = countOf(role.key);
  if (n > 0) { alert(`角色『${role.label}』下仍有 ${n} 个用户，请先调整这些用户的角色`); return; }
  if (!confirm(`确认删除角色『${role.label}』？`)) return;
  roles.value = roles.value.filter((r) => r.key !== role.key);
  delete perm.value[role.key];
}

// ---- 权限设置弹框 ----
// 编辑临时副本 draft，不影响页面上的 perm；取消直接关闭即丢弃改动。
function openPerm(r) {
  permError.value = '';
  permRole.value = { key: r.key, label: r.label };
  draft.value = JSON.parse(JSON.stringify(pOf(r.key)));
  selModule.value = PERM_MODULES[0].key;
}
function closePerm() {
  permRole.value = null;
  draft.value = null;
  permError.value = '';
}
// 平台级功能没有可勾选项：直接收起弹框并切到「用户列表」，引导去设置平台管理员。
function goUsersTab() {
  closePerm();
  activeTab.value = 'users';
}

// 底部「恢复该角色默认」：作用于 draft
function resetPermDraft() {
  if (!permRole.value) return;
  if (!confirm('恢复该角色的系统默认权限？')) return;
  draft.value = defaultRolePermissions(permRole.value.key);
}
function toggleDraftMenu() {
  if (!draft.value) return;
  const k = selModule.value;
  const arr = draft.value.menus;
  const i = arr.indexOf(k);
  if (i === -1) arr.push(k); else arr.splice(i, 1);
}
function toggleDraftAction(key) {
  if (!draft.value) return;
  draft.value.actions[key] = !draft.value.actions[key];
}
function selectAllModule(on) {
  if (!draft.value) return;
  for (const a of actionsOf(selModule.value)) draft.value.actions[a.key] = on;
}

async function savePermModal() {
  if (!permRole.value) return;
  permError.value = '';
  permSaving.value = true;
  try {
    perm.value[permRole.value.key] = JSON.parse(JSON.stringify(draft.value));
    await api.updateSettings({
      roles: roles.value.map((r) => ({ key: r.key, label: r.label })),
      permissions: JSON.parse(JSON.stringify(perm.value)),
    });
    emit('updated');
    await load();
    await loadConfig();
    closePerm();
  } catch (e) {
    // 把后端 400 的中文原因（锁死保护等）显示在弹框内，弹框不关闭
    permError.value = e.message;
  } finally {
    permSaving.value = false;
  }
}

onMounted(() => { load(); loadConfig(); });

// 在线状态轮询（v1.18.41）：立即拉一次 + 每 30s 刷新（与全局通知轮询同节奏）
onMounted(() => {
  loadPresence();
  presenceTimer = setInterval(loadPresence, 30000);
});
onUnmounted(() => {
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
});
</script>

<template>
  <section>
    <header class="page-head">
      <div>
        <h1>用户管理</h1>
        <p class="sub">管理系统用户、角色与功能权限<span v-if="currentOrg"> · 当前机构：{{ currentOrg.name }}</span></p>
      </div>
      <div class="actions">
        <button v-if="activeTab === 'users'" class="primary" @click="openCreate">+ 新增用户</button>
      </div>
    </header>

    <Tabs v-model="activeTab" :tabs="tabs" />

    <!-- ===== sheet 页：用户列表 ===== -->
    <div v-show="activeTab === 'users'">
      <div class="card">
        <h4>用户列表</h4>
        <p class="hint">仅显示归属「当前机构」的成员，角色为成员在本机构内的角色；要让已有账号加入别的机构，请到「机构管理 → 成员管理」指派。</p>
        <!-- 类型筛选（v1.18.15）：下拉改为二级 sheet 页，包一层 .sub-tabs 做紧凑变体以区分一级标签栏 -->
        <div class="sub-tabs">
          <Tabs v-model="typeFilter" :tabs="typeTabs" />
        </div>
        <p v-if="error" class="err">{{ error }}</p>
        <div class="table-wrap">
          <table class="mini">
          <thead>
            <tr><th>ID</th><th>用户名</th><th>姓名</th><th>电话</th><th>类型</th><th>角色</th><th>状态</th><th>在线</th><th>最近登录</th><th class="col-ops">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="u in filteredUsers" :key="u.id">
              <td class="col-id">{{ u.id }}</td>
              <td>{{ u.username }}</td>
              <td>
                {{ u.name }}
                <span v-if="u.platformAdmin" class="tag tag-pa">平台管理员</span>
              </td>
              <!-- 联系电话（v1.18.17）：空显示「—」，不显示 undefined -->
              <td class="col-phone">{{ u.phone ? u.phone : '—' }}</td>
              <td>
                <!-- 公司用户（v1.18.12）：醒目 chip；院方用户保持朴素灰字 -->
                <span v-if="u.userType === 'company'" class="type-chip" :title="typeTitle(u)">公司</span>
                <span v-else class="type-plain">院方</span>
              </td>
              <td>
                <!-- 平台管理员（v1.18.10）：其在全部机构的有效角色恒为管理员，机构内角色不可调整。
                     这里必须换成说明文字，不能留一个「改了不生效」的下拉。 -->
                <span
                  v-if="u.roleFixed"
                  class="role-fixed"
                  :title="`平台管理员在全部机构固定为管理员角色，不按机构调整（库中存的角色为「${u.storedRole}」）。如需限制其权限，请先取消其平台管理员身份。`"
                >{{ roleLabel(u.role) }} · 固定</span>
                <select v-else class="role-select" :value="u.role" @change="changeRole(u, $event.target.value)">
                  <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
                  <option v-if="!roles.some((r) => r.key === u.role)" :value="u.role">{{ u.role }}</option>
                </select>
              </td>
              <td>
                <span class="st" :class="u.active ? 'st-已解决' : 'st-已关闭'">{{ u.active ? '正常' : '已停用' }}</span>
              </td>
              <td>
                <span class="presence" :class="isOnline(u) ? 'on' : 'off'"><i></i>{{ isOnline(u) ? '在线' : '离线' }}</span>
              </td>
              <!-- 最近登录时间（v1.18.44）：null=从未登录显示「—」；YYYY-MM-DD HH:mm 窄列 -->
              <td class="col-lastlogin">{{ fmtLastLogin(u.lastLoginAt) }}</td>
              <td class="col-ops">
                <!-- 操作下拉（v1.18.32）：行内按钮过多收敛为单一下拉，与 v1.18.23 问题登记列表同款
                     （复用全局 .ops-* 样式，fixed 定位防 .table-wrap 裁剪）；
                     菜单项沿用原 v-if 条件与 handler，仅入口变化 -->
                <div class="ops-wrap" @click.stop>
                  <button
                    class="small ops-btn"
                    :aria-expanded="opsOpenId === u.id ? 'true' : 'false'"
                    aria-haspopup="menu"
                    @click.stop="toggleOps(u, $event)"
                  >操作
                    <svg class="ops-chev" :class="{ up: opsOpenId === u.id }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6" /></svg>
                  </button>
                  <div v-if="opsOpenId === u.id" class="ops-menu" role="menu" :style="{ top: opsPos.top + 'px', left: opsPos.left + 'px' }">
                    <button class="ops-item" role="menuitem" @click="doOp(resetPwd, u)">重置密码</button>
                    <!-- 改电话（v1.18.17）：所有有用户管理权限的人可见；后端边界兜底（多机构公司用户仅平台管理员可改） -->
                    <button class="ops-item" role="menuitem" title="联系电话用于值班表 / 处理人联系" @click="doOp(openPhone, u)">改电话</button>
                    <button
                      v-if="canPlatformAdmin"
                      class="ops-item" role="menuitem"
                      title="跨机构管理权限"
                      @click="doOp(togglePlatformAdmin, u)"
                    >{{ u.platformAdmin ? '取消平台管理员' : '设为平台管理员' }}</button>
                    <!-- 公司用户多机构分配（v1.18.12，仅平台管理员） -->
                    <button
                      v-if="canPlatformAdmin && u.userType === 'company'"
                      class="ops-item" role="menuitem"
                      title="公司用户可同时归属多个机构"
                      @click="doOp(openAssign, u)"
                    >分配机构</button>
                    <!-- 切换用户类型（v1.18.12，仅平台管理员） -->
                    <button
                      v-if="canPlatformAdmin"
                      class="ops-item" role="menuitem"
                      :title="u.userType === 'company' ? '改为院方用户（须先移出多余机构）' : '改为公司用户（可分配多机构）'"
                      @click="doOp(toggleType, u)"
                    >{{ u.userType === 'company' ? '改为院方' : '改为公司' }}</button>
                    <button
                      class="ops-item" role="menuitem"
                      :class="{ danger: u.active }"
                      @click="doOp(toggle, u)"
                    >{{ u.active ? '停用' : '启用' }}</button>
                  </div>
                </div>
              </td>
            </tr>
            <tr v-if="filteredUsers.length === 0"><td colspan="9" class="empty">暂无用户</td></tr>
          </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ===== sheet 页：角色与权限 ===== -->
    <div v-show="activeTab === 'roles'">
      <div class="card">
        <h4>角色管理</h4>
        <p class="hint">内置角色（管理员 / 登记员）不可删除、可改名；自定义角色可新增 / 改名 / 删除，但删除前需先移走该角色下的用户。</p>
        <div class="table-wrap">
          <table class="mini">
          <thead>
            <tr><th>角色标识</th><th>名称</th><th>用户数</th><th>权限概览</th><th>类型</th><th class="col-ops">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in roles" :key="r.key">
              <td><code>{{ r.key }}</code></td>
              <td>{{ r.label }}</td>
              <td>{{ countOf(r.key) }}</td>
              <td>{{ permCount(r.key) }} 项</td>
              <td><span class="tag" :class="r.builtin ? 'tag-builtin' : 'tag-custom'">{{ r.builtin ? '内置' : '自定义' }}</span></td>
              <td class="col-ops">
                <button class="small" @click="openPerm(r)">权限设置</button>
                <button class="small" @click="renameRole(r)">改名</button>
                <button class="small danger" :disabled="r.builtin" @click="removeRole(r)">删除</button>
              </td>
            </tr>
          </tbody>
          </table>
        </div>
        <div class="add-role">
          <label class="inline">名称<input v-model="newRole.label" placeholder="如：回访专员" /></label>
          <label class="inline">标识（可选）<input v-model="newRole.key" placeholder="留空自动生成，如 reviewer" /></label>
          <button class="small primary" @click="addRole">+ 新增角色</button>
        </div>
        <p v-if="roleError" class="err">{{ roleError }}</p>
      </div>

      <p class="hint">点击角色行的「权限设置」，在弹框中按左栏菜单 / 模块配置该角色的菜单与功能权限；保存后即生效（角色成员重新进入页面后按新权限显示）。</p>
    </div>

    <!-- ===== 新增用户弹框（顶层，独立于标签页）===== -->
    <div v-if="showCreate" class="modal-mask">
      <div class="modal narrow">
        <h3>新增用户</h3>
        <label class="full">用户名*<input v-model="form.username" placeholder="登录名" /></label>
        <label class="full">姓名<input v-model="form.name" placeholder="显示名" /></label>
        <!-- 联系电话（v1.18.17）：选填，随创建提交 -->
        <label class="full">联系电话（选填）<input v-model="form.phone" type="tel" maxlength="20" placeholder="选填，用于值班表/处理人联系" /></label>
        <label class="full">密码*<input v-model="form.password" type="password" placeholder="至少 6 位" /></label>
        <!-- 用户类型（v1.18.12）：仅平台管理员可见；机构管理员不显示该项、创建的永远是院方用户 -->
        <label v-if="canPlatformAdmin" class="full">用户类型
          <select v-model="form.userType">
            <option value="hospital">院方用户（默认）</option>
            <option value="company">公司用户（可分配多机构）</option>
          </select>
        </label>
        <label class="full">角色
          <select v-model="form.role">
            <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
          </select>
        </label>
        <p v-if="createError" class="err">{{ createError }}</p>
        <div class="modal-actions">
          <button class="primary" @click="create">创建用户</button>
          <button @click="closeCreate">取消</button>
        </div>
      </div>
    </div>

    <!-- ===== 权限设置弹框（左菜单 / 右功能，顶层）===== -->
    <div v-if="permRole" class="modal-mask">
      <div class="modal wide">
        <h3>权限设置 · {{ permRole.label }}</h3>
        <p class="hint key-sub">{{ permRole.key }}</p>
        <div class="perm-layout">
          <div class="perm-mods">
            <button
              v-for="m in PERM_MODULES"
              :key="m.key"
              class="perm-mod"
              :class="{ active: selModule === m.key }"
              @click="selModule = m.key"
            >
              <span class="perm-mod-name">{{ m.label }}</span>
              <span class="perm-mod-count">{{ moduleCount(m.key) }}</span>
            </button>
            <!-- 平台级功能：不属于本机构角色权限，只列出并标注，避免「导航里有、这里没有」的困惑 -->
            <div class="perm-group-title">平台级功能</div>
            <button
              v-for="m in PLATFORM_MODULES"
              :key="m.key"
              class="perm-mod"
              :class="{ active: selModule === m.key }"
              @click="selModule = m.key"
            >
              <span class="perm-mod-name">{{ m.label }}</span>
              <span class="perm-mod-lock">平台级</span>
            </button>
          </div>
          <div class="perm-pane">
            <div class="perm-pane-head">
              <span class="perm-pane-title">{{ moduleLabel(selModule) }}</span>
              <span v-if="!selPlatform && actionsOf(selModule).length" class="perm-pane-ops">
                <button class="small" type="button" @click="selectAllModule(true)">全选</button>
                <button class="small" type="button" @click="selectAllModule(false)">全不选</button>
              </span>
            </div>
            <template v-if="selPlatform">
              <p class="perm-note">{{ selPlatform.desc }}</p>
              <p class="perm-note">
                授权方式：在「用户列表」中把对应用户设为<span class="perm-em">平台管理员</span>，该标识与机构无关、全局生效。
                本弹框配置的是「当前机构内该角色」的权限，因此这里不提供开关。
              </p>
              <button class="small" type="button" @click="goUsersTab">去用户列表设置</button>
            </template>
            <template v-else>
              <label v-if="isMenu(selModule)" class="perm-check">
                <input type="checkbox" :checked="draft.menus.includes(selModule)" @change="toggleDraftMenu" />
                <span>显示此菜单</span>
              </label>
              <template v-if="actionsOf(selModule).length">
                <label v-for="a in actionsOf(selModule)" :key="a.key" class="perm-check">
                  <input type="checkbox" :checked="draft.actions[a.key]" @change="toggleDraftAction(a.key)" />
                  <span>{{ a.label }}</span>
                </label>
              </template>
              <p v-else class="perm-none">该菜单暂无独立功能权限</p>
            </template>
          </div>
        </div>
        <p v-if="permError" class="err">{{ permError }}</p>
        <div class="modal-actions">
          <button class="small" :disabled="permSaving" @click="resetPermDraft">恢复该角色默认</button>
          <button class="primary" :disabled="permSaving" @click="savePermModal">{{ permSaving ? '保存中…' : '保存' }}</button>
          <button :disabled="permSaving" @click="closePerm">取消</button>
        </div>
      </div>
    </div>

    <!-- ===== 分配机构弹框（v1.18.12，公司用户多机构归属，仅平台管理员）===== -->
    <div v-if="assignOpen" class="modal-mask">
      <div class="modal wide">
        <h3>分配机构 · {{ assignUser?.name || assignUser?.username }}</h3>
        <p class="hint">公司用户可同时归属多个机构，各机构内角色互相独立；院方用户只能属于一个机构。</p>

        <div class="table-wrap">
          <table class="mini">
            <thead>
              <tr><th>机构</th><th>机构内角色</th><th>机构状态</th><th class="col-ops">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in assignList" :key="m.orgId">
                <td>{{ m.orgName || m.orgId }}</td>
                <td>
                  <select class="role-select" :value="m.role" :disabled="assignSaving" @change="changeAssignRole(m, $event.target.value)">
                    <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
                    <option v-if="!roles.some((x) => x.key === m.role)" :value="m.role">{{ m.role }}</option>
                  </select>
                </td>
                <td><span class="st" :class="m.orgActive ? 'st-已解决' : 'st-已关闭'">{{ m.orgActive ? '启用' : '已停用' }}</span></td>
                <td class="col-ops">
                  <button class="small danger" :disabled="assignSaving" @click="removeAssign(m)">移除</button>
                </td>
              </tr>
              <tr v-if="assignList.length === 0"><td colspan="4" class="empty">尚未归属任何机构</td></tr>
            </tbody>
          </table>
        </div>

        <div class="assign-add">
          <select v-model="assignAddOrgId">
            <option value="">选择要加入的机构…</option>
            <option v-for="o in assignableOrgs" :key="o.id" :value="String(o.id)">{{ o.name }}</option>
          </select>
          <select v-model="assignAddRole">
            <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
          </select>
          <button class="small primary" :disabled="assignSaving || !assignAddOrgId" @click="addAssign">+ 添加机构</button>
        </div>
        <p v-if="!assignableOrgs.length" class="hint">该用户已归属全部机构。</p>
        <p v-if="assignErr" class="err">{{ assignErr }}</p>
        <div class="modal-actions">
          <button :disabled="assignSaving" @click="closeAssign">关闭</button>
        </div>
      </div>
    </div>

    <!-- ===== 改电话弹框（v1.18.17）===== -->
    <div v-if="phoneOpen" class="modal-mask" @click.self>
      <div class="modal narrow phone-modal">
        <h3>修改联系电话 · {{ phoneUser?.name || phoneUser?.username }}</h3>
        <p class="hint">电话为账号级字段（与密码同级）：平台管理员可改任意账号，机构管理员仅限「仅属本机构」的账号。</p>
        <label class="full">联系电话<input v-model="phoneDraft" type="tel" maxlength="20" placeholder="选填，用于值班表/处理人联系；留空即清除" @keyup.enter="savePhone" /></label>
        <p v-if="phoneErr" class="err">{{ phoneErr }}</p>
        <div class="modal-actions">
          <button class="primary" :disabled="phoneSaving" @click="savePhone">{{ phoneSaving ? '保存中…' : '保存' }}</button>
          <button :disabled="phoneSaving" @click="closePhone">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hint.key-sub { margin: -8px 0 14px; font-family: ui-monospace, monospace; font-size: 12px; }

/* 弹框主体：左菜单 / 右功能 */
.perm-layout { display: flex; gap: 16px; }
.perm-mods { width: 176px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
.perm-mod {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 9px 12px; border: 1px solid transparent; background: transparent;
  border-left: 3px solid transparent; border-radius: 8px;
  font-size: 13px; color: var(--text); text-align: left;
}
.perm-mod:hover { background: var(--panel-2); }
.perm-mod.active { background: #eef4ff; border-left-color: var(--primary); color: var(--primary-d); font-weight: 650; }
.perm-mod-count { font-size: 11.5px; color: var(--muted); font-weight: 400; }
.perm-mod.active .perm-mod-count { color: var(--primary-d); }

/* 左栏「平台级功能」分组标题与标记 */
.perm-group-title {
  margin-top: 10px; padding: 10px 12px 2px;
  border-top: 1px solid var(--border);
  font-size: 11px; font-weight: 650; letter-spacing: .06em; color: var(--muted);
}
.perm-mod-lock {
  flex-shrink: 0; padding: 1px 7px; border-radius: 999px;
  font-size: 11px; background: #fef3c7; color: #b45309;
}
.perm-mod.active .perm-mod-lock { background: #fde68a; }

.perm-pane { flex: 1; min-width: 0; max-height: 46vh; overflow: auto; padding-left: 4px; }
.perm-pane-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.perm-pane-title { font-size: 13px; font-weight: 650; color: #48566b; }
.perm-pane-ops { display: flex; gap: 6px; }
.perm-check {
  display: flex; flex-direction: row; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 8px; font-size: 13px; color: var(--text); cursor: pointer;
}
.perm-check:hover { background: var(--panel-2); }
.perm-check input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--primary); cursor: pointer; }
.perm-none { color: var(--muted); font-size: 12.5px; padding: 18px 10px; }
/* 平台级功能的说明文案（右栏，无可勾选项） */
.perm-note { margin: 0 0 8px; padding: 6px 10px; color: var(--muted); font-size: 12.5px; line-height: 1.75; }
.perm-note:last-of-type { margin-bottom: 12px; }
.perm-em { color: var(--primary-d); font-weight: 650; }

.add-role { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
.add-role .inline { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
.add-role .inline input { padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: 9px; font-size: 13px; background: #fbfcfe; min-width: 160px; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; }
.tag-builtin { background: #eff6ff; color: #1d4ed8; }
.tag-custom { background: #f1f5f9; color: #475569; }
.tag-pa { background: #fef3c7; color: #b45309; margin-left: 6px; }
/* 用户类型（v1.18.12）：公司用户用主色系 chip 醒目标注；院方用户保持朴素灰字 */
.type-chip {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 650;
  background: #eef4ff; color: #1d4ed8;
  border: 1px solid #c3d7fb;
}
.type-plain { font-size: 12px; color: var(--muted); }
/* 二级 sheet 页（v1.18.15）：类型筛选标签栏，比一级 tabs 略紧凑以体现层级；选中态样式沿用 Tabs 组件 */
.sub-tabs { margin: -4px 0 2px; }
.sub-tabs :deep(.tabs) { margin: 0 0 12px; }
.sub-tabs :deep(.tab) { padding: 6px 11px; font-size: 12.5px; }
/* 联系电话（v1.18.17）：列表「电话」列窄列呈现；改电话小弹框限宽 */
.col-phone { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.phone-modal { max-width: 430px; }
.phone-modal .hint { margin-bottom: 12px; }
/* 分配机构弹框：机构下拉 + 角色下拉 + 添加按钮 */
.assign-add { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
.assign-add select {
  padding: 8px 11px; border: 1px solid var(--border-strong); border-radius: 9px;
  background: #fbfcfe; font-size: 13px; color: var(--text); min-width: 190px;
}
.assign-add select:focus { outline: none; border-color: var(--primary); background: #fff; box-shadow: 0 0 0 3px rgba(37, 99, 235, .13); }
.role-select { padding: 5px 9px; border: 1px solid var(--border-strong); border-radius: 8px; background: #fff; font-size: 13px; color: var(--text); }
.role-select:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, .13); }
/* 平台管理员：机构内角色固定，用只读文字替代下拉（v1.18.10），避免「改了不生效」的假控件 */
.role-fixed {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12.5px; color: var(--muted);
  background: var(--panel-2); border: 1px dashed var(--border-strong);
  border-radius: 8px; padding: 4px 9px; cursor: default;
}
/* 操作下拉（v1.18.32）：复用全局 .ops-wrap/.ops-btn/.ops-chev/.ops-menu/.ops-item 样式（v1.18.23），
   此处零新增——保证两处下拉视觉与行为完全一致 */

/* 在线状态（v1.18.41）：圆点 + 文字，绿=在线 / 灰=离线（与状态列 pill 视觉同族但不共底色） */
.presence {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; white-space: nowrap;
}
.presence i {
  width: 8px; height: 8px; border-radius: 50%; display: inline-block;
}
.presence.on { color: #15803d; }
.presence.on i { background: #22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, .18); }
.presence.off { color: var(--muted); }
.presence.off i { background: #c3cddc; }

/* 最近登录时间（v1.18.44）：窄列、不换行、等宽数字；未登录「—」随 muted 色 */
.col-lastlogin {
  white-space: nowrap;
  color: var(--muted);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
</style>
