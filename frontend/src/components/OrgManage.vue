<script setup>
// 机构管理（v1.18，仅平台管理员可见）：机构增删改 + 成员与机构内角色指派。
// 该页是「跨机构」的管理入口，因此不做菜单权限控制，而由父组件按 platformAdmin 决定显隐。
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  currentOrgId: { type: [Number, String], default: null },
});
const emit = defineEmits(['changed']);

const orgs = ref([]);
const error = ref('');
const loading = ref(false);

// 新建 / 编辑机构弹框（顶层状态，草稿式：取消即丢弃）
const editOpen = ref(false);
const editMode = ref('create');   // create | edit
const editForm = ref({ id: null, code: '', name: '' });
const editErr = ref('');
const editSaving = ref(false);

// 成员管理弹框
const memOpen = ref(false);
const memOrg = ref(null);
const memRoles = ref([]);
const memMembers = ref([]);
const memCandidates = ref([]);
const memErr = ref('');
const memSaving = ref(false);
const addUserId = ref('');
const addRole = ref('');

function isCurrent(o) {
  return props.currentOrgId != null && String(props.currentOrgId) === String(o.id);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.listOrgs();
    orgs.value = Array.isArray(r.orgs) ? r.orgs : [];
  } catch (e) {
    error.value = e.message || '加载机构列表失败';
  } finally {
    loading.value = false;
  }
}

// ---- 新建 / 编辑 ----
function openCreate() {
  editErr.value = '';
  editMode.value = 'create';
  editForm.value = { id: null, code: '', name: '' };
  editOpen.value = true;
}
function openEdit(o) {
  editErr.value = '';
  editMode.value = 'edit';
  editForm.value = { id: o.id, code: o.code, name: o.name };
  editOpen.value = true;
}
function closeEdit() {
  editOpen.value = false;
  editErr.value = '';
}
async function saveOrg() {
  editErr.value = '';
  const name = (editForm.value.name || '').trim();
  if (!name) { editErr.value = '请填写机构名称'; return; }
  if (orgs.value.some((o) => o.name === name && String(o.id) !== String(editForm.value.id))) {
    editErr.value = `机构名称「${name}」已存在`; return;
  }
  editSaving.value = true;
  try {
    if (editMode.value === 'create') {
      await api.createOrg({ code: (editForm.value.code || '').trim(), name });
    } else {
      // 标识（code）仅在新建时确定，避免影响既有引用；编辑只改名称
      await api.updateOrg(editForm.value.id, { name });
    }
    editOpen.value = false;
    await load();
    emit('changed');
  } catch (e) {
    editErr.value = e.message || '保存失败';
  } finally {
    editSaving.value = false;
  }
}

// ---- 启用 / 停用 ----
async function toggleActive(o) {
  const act = o.active ? '停用' : '启用';
  if (!confirm(`确认${act}机构「${o.name}」？\n停用后其成员将无法切换到该机构。`)) return;
  try {
    await api.updateOrg(o.id, { active: !o.active });
    await load();
    emit('changed');
  } catch (e) {
    alert(e.message || `${act}失败`);
  }
}

// ---- 删除 ----
async function remove(o) {
  if (!confirm(`确认删除机构「${o.name}」？\n该机构的成员关系将被一并清除（其业务数据不会自动迁移），此操作不可恢复。`)) return;
  try {
    await api.removeOrg(o.id);
    await load();
    emit('changed');
  } catch (e) {
    alert(e.message || '删除失败');
  }
}

// ---- 成员管理 ----
function defaultRole() {
  return memRoles.value.some((r) => r.key === 'reporter') ? 'reporter' : (memRoles.value[0]?.key || '');
}
async function openMembers(o) {
  memOrg.value = { id: o.id, name: o.name };
  memErr.value = '';
  addUserId.value = '';
  memOpen.value = true;
  await loadMembers();
}
async function loadMembers() {
  if (!memOrg.value) return;
  try {
    const r = await api.listOrgMembers(memOrg.value.id);
    memRoles.value = Array.isArray(r.roles) ? r.roles : [];
    memMembers.value = Array.isArray(r.members) ? r.members : [];
    memCandidates.value = Array.isArray(r.candidates) ? r.candidates : [];
    if (!addRole.value || !memRoles.value.some((x) => x.key === addRole.value)) addRole.value = defaultRole();
    if (addUserId.value && !memCandidates.value.some((c) => String(c.id) === String(addUserId.value))) addUserId.value = '';
  } catch (e) {
    memErr.value = e.message || '加载成员失败';
  }
}
function closeMembers() {
  memOpen.value = false;
  memOrg.value = null;
  memErr.value = '';
  memMembers.value = [];
  memCandidates.value = [];
}
async function addMember() {
  memErr.value = '';
  if (!memOrg.value) return;
  if (!addUserId.value) { memErr.value = '请选择要加入的用户'; return; }
  // 平台管理员：无论选择器显示什么，一律按固定管理员角色提交（后端同样会纠正）
  const role = addRoleLocked.value ? FIXED_ADMIN_KEY : addRole.value;
  if (!role) { memErr.value = '请选择角色'; return; }
  memSaving.value = true;
  try {
    const r = await api.addOrgMember(memOrg.value.id, { userId: Number(addUserId.value), role });
    addUserId.value = '';
    await loadMembers();
    await load();
    if (r && r.coerced) {
      memErr.value = '该用户是平台管理员，其在全部机构固定为管理员角色，已按规则设为管理员。';
    }
  } catch (e) {
    memErr.value = e.message || '添加失败';
  } finally {
    memSaving.value = false;
  }
}
async function changeMemberRole(m, role) {
  memErr.value = '';
  if (!memOrg.value || role === m.role) return;
  if (m.roleFixed) return;   // 平台管理员角色固定，界面已不给选择器，这里兜底
  memSaving.value = true;
  try {
    const r = await api.addOrgMember(memOrg.value.id, { userId: Number(m.userId), role });
    await loadMembers();
    if (r && r.coerced) {
      memErr.value = '该用户是平台管理员，其在全部机构固定为管理员角色，已按规则设为管理员。';
    }
  } catch (e) {
    memErr.value = e.message || '角色修改失败';
    await loadMembers();   // 失败回滚显示
  } finally {
    memSaving.value = false;
  }
}
async function kick(m) {
  memErr.value = '';
  if (!memOrg.value) return;
  if (!confirm(`确认把「${m.name || m.username}」移出机构「${memOrg.value.name}」？`)) return;
  memSaving.value = true;
  try {
    await api.removeOrgMember(memOrg.value.id, m.userId);
    await loadMembers();
    await load();
  } catch (e) {
    memErr.value = e.message || '移出失败';
  } finally {
    memSaving.value = false;
  }
}

const candidateLabel = computed(() => (c) => `${c.name}${c.username && c.username !== c.name ? '（' + c.username + '）' : ''}`);

// 平台管理员加入任何机构都会被固定为管理员角色（v1.18.10）：
// 选中这类候选时把角色选择器锁住并显示管理员，避免「选了登记员、加进去却是管理员」的意外。
// 固定用的角色 key = 内置管理员角色（与后端 PLATFORM_ADMIN_ROLE 一致）。
const FIXED_ADMIN_KEY = 'admin';
const addCandidate = computed(() => memCandidates.value.find((c) => String(c.id) === String(addUserId.value)) || null);
const addRoleLocked = computed(() => !!(addCandidate.value && addCandidate.value.platformAdmin));
const fixedAdminLabel = computed(() => {
  const r = memRoles.value.find((x) => x.key === FIXED_ADMIN_KEY);
  return (r && r.label) || FIXED_ADMIN_KEY;
});
// 已存在的成员里，平台管理员的角色也是固定的
function memberRoleLabel(m) {
  const r = memRoles.value.find((x) => x.key === m.role);
  return (r && r.label) || m.role || '';
}

onMounted(load);
</script>

<template>
  <section>
    <header class="page-head">
      <div>
        <h1>机构管理</h1>
        <p class="sub">维护机构与各机构成员 · 机构之间的问题登记、用户、通知、聊天、值班表、操作日志彼此完全隔离</p>
      </div>
      <div class="actions">
        <button class="primary" @click="openCreate">+ 新建机构</button>
      </div>
    </header>

    <div class="card">
      <h4>机构列表</h4>
      <p v-if="error" class="err">{{ error }}</p>
      <div class="table-wrap">
        <table class="mini">
          <thead>
            <tr>
              <th class="col-id">ID</th>
              <th>机构名称</th>
              <th>标识</th>
              <th>成员数</th>
              <th>状态</th>
              <th class="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orgs" :key="o.id">
              <td class="col-id">{{ o.id }}</td>
              <td>
                {{ o.name }}
                <span v-if="isCurrent(o)" class="tag tag-cur">当前</span>
              </td>
              <td><code>{{ o.code }}</code></td>
              <td>{{ o.memberCount ?? 0 }}</td>
              <td>
                <span class="st" :class="o.active ? 'st-已解决' : 'st-已关闭'">{{ o.active ? '启用' : '已停用' }}</span>
              </td>
              <td class="col-ops">
                <button class="small" @click="openMembers(o)">成员管理</button>
                <button class="small" @click="openEdit(o)">改名</button>
                <button class="small" :class="o.active ? 'danger' : 'primary'" @click="toggleActive(o)">{{ o.active ? '停用' : '启用' }}</button>
                <button class="small danger" @click="remove(o)">删除</button>
              </td>
            </tr>
            <tr v-if="!loading && orgs.length === 0"><td colspan="6" class="empty">暂无机构</td></tr>
            <tr v-else-if="loading && orgs.length === 0"><td colspan="6" class="empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <p class="hint hint-foot">为保证系统始终可用，至少保留一个启用中的机构；默认机构（ID 最小者）不可删除。新建机构时会按机构名初始化它自己的系统名称，其余配置取系统默认值，可由该机构管理员自行调整。</p>
    </div>

    <!-- ===== 新建 / 编辑机构弹框 ===== -->
    <div v-if="editOpen" class="modal-mask">
      <div class="modal narrow">
        <h3>{{ editMode === 'create' ? '新建机构' : '修改机构' }}</h3>
        <label class="full">机构名称*<input v-model="editForm.name" maxlength="60" placeholder="例如：海盐县人民医院" /></label>
        <label class="full">机构标识
          <input v-model="editForm.code" maxlength="50" :disabled="editMode === 'edit'" placeholder="英文/数字，留空自动生成" />
        </label>
        <p v-if="editMode === 'edit'" class="hint modal-hint">机构标识在建机构时确定，后续不可修改。</p>
        <p v-if="editErr" class="err">{{ editErr }}</p>
        <div class="modal-actions">
          <button class="primary" :disabled="editSaving" @click="saveOrg">{{ editSaving ? '保存中…' : '保存' }}</button>
          <button :disabled="editSaving" @click="closeEdit">取消</button>
        </div>
      </div>
    </div>

    <!-- ===== 成员管理弹框 ===== -->
    <div v-if="memOpen" class="modal-mask">
      <div class="modal wide">
        <h3>成员管理 · {{ memOrg?.name }}</h3>
        <p class="hint">成员在「本机构内」的角色决定其在本机构可见的菜单与功能；同一账号在不同机构可有不同角色。</p>

        <div class="add-member">
          <select v-model="addUserId">
            <option value="">选择要加入的用户…</option>
            <option v-for="c in memCandidates" :key="c.id" :value="String(c.id)">{{ candidateLabel(c) }}</option>
          </select>
          <select v-if="!addRoleLocked" v-model="addRole">
            <option v-for="r in memRoles" :key="r.key" :value="r.key">{{ r.label }}</option>
          </select>
          <!-- 平台管理员：加入即固定为管理员，角色选择器锁住并说明原因（v1.18.10） -->
          <span v-else class="role-fixed" title="平台管理员在全部机构固定为管理员角色，加入本机构后角色不可按机构调整">
            {{ fixedAdminLabel }} · 固定
          </span>
          <button class="small primary" :disabled="memSaving || !addUserId" @click="addMember">+ 加入机构</button>
        </div>
        <p v-if="!memCandidates.length" class="hint">没有可加入的用户：系统内所有启用账号都已是本机构成员，可先到「用户管理」新增账号。</p>

        <div class="table-wrap">
          <table class="mini">
            <thead>
              <tr><th>姓名</th><th>用户名</th><th>机构内角色</th><th>账号状态</th><th class="col-ops">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in memMembers" :key="m.userId">
                <td>
                  {{ m.name }}
                  <span v-if="m.platformAdmin" class="tag tag-pa">平台管理员</span>
                </td>
                <td>{{ m.username }}</td>
                <td>
                  <!-- 平台管理员：有效角色恒为管理员，不可按机构调整 → 换成说明文字（v1.18.10） -->
                  <span
                    v-if="m.roleFixed"
                    class="role-fixed"
                    :title="`平台管理员在全部机构固定为管理员角色，不按机构调整（库中存的角色为「${m.storedRole}」）。如需限制其权限，请先到「用户管理」取消其平台管理员身份。`"
                  >{{ memberRoleLabel(m) }} · 固定</span>
                  <select v-else class="role-select" :value="m.role" :disabled="memSaving" @change="changeMemberRole(m, $event.target.value)">
                    <option v-for="r in memRoles" :key="r.key" :value="r.key">{{ r.label }}</option>
                    <option v-if="!memRoles.some((r) => r.key === m.role)" :value="m.role">{{ m.role }}</option>
                  </select>
                </td>
                <td><span class="st" :class="m.active ? 'st-已解决' : 'st-已关闭'">{{ m.active ? '正常' : '已停用' }}</span></td>
                <td class="col-ops">
                  <button class="small danger" :disabled="memSaving" @click="kick(m)">移出</button>
                </td>
              </tr>
              <tr v-if="memMembers.length === 0"><td colspan="5" class="empty">该机构暂无成员</td></tr>
            </tbody>
          </table>
        </div>
        <p v-if="memErr" class="err">{{ memErr }}</p>
        <div class="modal-actions">
          <button :disabled="memSaving" @click="closeMembers">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; margin-left: 6px; }
.tag-cur { background: #eff6ff; color: #1d4ed8; }
.tag-pa { background: #fef3c7; color: #b45309; }
.hint-foot { margin: 14px 0 0; }
.modal-hint { margin: 4px 0 0; }
.add-member { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.add-member select {
  padding: 8px 11px; border: 1px solid var(--border-strong); border-radius: 9px;
  background: #fbfcfe; font-size: 13px; color: var(--text); min-width: 190px;
}
.add-member select:focus { outline: none; border-color: var(--primary); background: #fff; box-shadow: 0 0 0 3px rgba(37, 99, 235, .13); }
.role-select { padding: 5px 9px; border: 1px solid var(--border-strong); border-radius: 8px; background: #fff; font-size: 13px; color: var(--text); }
.role-select:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, .13); }
/* 平台管理员：机构内角色固定，用只读文字替代下拉（v1.18.10），避免「改了不生效」的假控件 */
.role-fixed {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12.5px; color: var(--muted);
  background: var(--panel-2); border: 1px dashed var(--border-strong);
  border-radius: 8px; padding: 4px 9px; cursor: default;
}
</style>
