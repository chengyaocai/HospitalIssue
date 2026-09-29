<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';
import Tabs from './Tabs.vue';

const emit = defineEmits(['updated']);
const props = defineProps({ canEdit: { type: Boolean, default: true } });

// sheet 页：基础设置 / 下拉选项（v-show 切换，保留未保存的本地编辑状态）
const tabs = [
  { key: 'base', label: '基础设置' },
  { key: 'lists', label: '下拉选项' },
];
const activeTab = ref('base');

const appName = ref('');
const systems = ref([]);         // 软件系统候选（列表维护）
const loading = ref(false);      // 系统名称保存中
const listSaving = ref(false);   // 名单保存中
const error = ref('');
const ok = ref(false);
const listError = ref('');
const listOk = ref(false);

const newSystem = ref('');

// v1.18.16：处理人候选名单改为**派生自本机构的公司用户**（在「用户管理」创建公司用户、
// 或「机构管理 → 成员管理」分配到本机构后自动出现），本页不再提供手工维护界面；
// 系统设置存储里的旧 handlers 数据仅留档，不再被读取。

onMounted(async () => {
  try {
    const c = await api.getConfig();
    appName.value = c.appName || '';
    systems.value = Array.isArray(c.softwareSystems) ? [...c.softwareSystems] : [];
  } catch (e) {
    error.value = e.message;
  }
});

// 保存系统名称
async function saveName() {
  error.value = '';
  ok.value = false;
  if (!props.canEdit) return;
  if (!appName.value.trim()) { error.value = '系统名称不能为空'; return; }
  loading.value = true;
  try {
    const c = await api.updateSettings({ appName: appName.value.trim() });
    appName.value = c.appName;
    ok.value = true;
    emit('updated', c.appName);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// 名单增删后即时持久化（软件系统候选名单）。
// v1.18.16：不再发送 / 校验 handlers —— 处理人候选已改为机构公司用户派生，无需在此维护。
async function persistLists() {
  if (!props.canEdit) return;
  listError.value = '';
  listOk.value = false;
  listSaving.value = true;
  try {
    const c = await api.updateSettings({
      softwareSystems: systems.value,
    });
    systems.value = Array.isArray(c.softwareSystems) ? [...c.softwareSystems] : [];
    listOk.value = true;
  } catch (e) {
    listError.value = e.message;
  } finally {
    listSaving.value = false;
  }
}

function addSystem() {
  const v = newSystem.value.trim();
  if (!v) return;
  if (systems.value.includes(v)) { listError.value = `软件系统「${v}」已存在`; return; }
  systems.value.push(v);
  newSystem.value = '';
  persistLists();
}
function removeSystem(i) {
  systems.value.splice(i, 1);
  persistLists();
}
</script>

<template>
  <section>
    <header class="page-head">
      <div>
        <h1>系统设置</h1>
        <p class="sub">配置系统显示信息与下拉选项 · 以下配置均作用于「当前机构」，多机构部署下各机构彼此独立</p>
      </div>
    </header>

    <Tabs v-model="activeTab" :tabs="tabs" />

    <!-- ===== sheet 页：基础设置 ===== -->
    <div v-show="activeTab === 'base'">
      <div class="card">
        <h4>系统名称</h4>
        <p class="hint">显示在左侧导航顶部与浏览器标题；保存后立即生效，无需重启或重新打包。</p>
        <label class="full">系统名称<input v-model="appName" maxlength="60" :disabled="!canEdit" placeholder="例如：海盐县人民医院 · 信息科问题登记" /></label>
        <p v-if="error" class="err">{{ error }}</p>
        <p v-if="ok" class="okmsg">已保存</p>
        <div class="modal-actions">
          <button v-if="canEdit" class="primary" :disabled="loading" @click="saveName">{{ loading ? '保存中…' : '保存' }}</button>
        </div>
      </div>

      <div class="card">
        <h4>其他配置（通过 backend/.env 环境变量）</h4>
        <ul class="tips">
          <li><code>APP_NAME</code> — 系统名称默认值（被上面的在线设置覆盖）</li>
          <li><code>JWT_SECRET</code> / <code>ADMIN_PASSWORD</code> — 上线前务必修改</li>
          <li><code>DB_DRIVER</code> — <code>mssql</code>（生产）/ <code>dev</code>（本地）</li>
          <li><code>UPLOADS_DIR</code> — 附件存放目录</li>
        </ul>
      </div>
    </div>

    <!-- ===== sheet 页：下拉选项 ===== -->
    <div v-show="activeTab === 'lists'">
      <p class="hint">处理人候选取自本机构的<strong>公司用户</strong>（在「用户管理」创建公司用户、或「机构管理 → 成员管理」分配到本机构后自动出现，无需在此维护）。</p>

      <div class="card">
        <h4>软件系统候选名单</h4>
        <p class="hint">用于「问题登记 / 编辑」中软件系统下拉框；点「添加」后即时保存生效。</p>

        <div v-if="canEdit" class="add-row">
          <input v-model="newSystem" maxlength="30" placeholder="输入软件系统名称，如：HIS" @keyup.enter="addSystem" />
          <button class="primary" :disabled="listSaving || !newSystem.trim()" @click="addSystem">+ 添加</button>
        </div>

        <div class="table-wrap">
          <table class="mini">
            <thead>
              <tr><th class="col-id">序号</th><th>系统名称</th><th v-if="canEdit" class="col-ops">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in systems" :key="s">
                <td class="col-id">{{ i + 1 }}</td>
                <td>{{ s }}</td>
                <td v-if="canEdit" class="col-ops">
                  <button class="small danger" :disabled="listSaving" @click="removeSystem(i)">删除</button>
                </td>
              </tr>
              <tr v-if="systems.length === 0"><td :colspan="canEdit ? 3 : 2" class="empty">暂无软件系统，请在上方添加</td></tr>
            </tbody>
          </table>
        </div>
        <p v-if="listError" class="err">{{ listError }}</p>
        <p v-if="listOk" class="okmsg">名单已保存</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.add-row { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
.add-row input {
  flex: 1;
  max-width: 200px;
  padding: 8px 12px;
  border: 1px solid var(--border, #d8dfe8);
  border-radius: 8px;
  font-size: 14px;
}
.add-row input:focus { outline: none; border-color: var(--primary); }
</style>
