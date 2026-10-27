<script setup>
// 业务服务管理（v1.18.82）：登记医院各系统/服务的地址、账号、密码、路径、用途等信息，方便查询管理。
// 查看对有菜单权限的用户开放；新增/编辑/删除需「服务维护」权限（service.manage）。
// 密码列默认掩码显示，按行眼睛图标临时明文，提供一键复制；服务地址可点击新标签打开。
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  canManage: { type: Boolean, default: false },
});

const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(50);
const q = ref('');
const type = ref('');
const env = ref('');
const enabled = ref('');
const types = ref([]);
const envs = ref([]);
const loading = ref(false);
const error = ref('');

// 弹窗表单（null=关闭；编辑时带原记录 id）
const form = ref(null);
const saving = ref(false);
const showPwd = ref(false); // 表单内密码明文开关
// 列表内按行明文密码的 id 集合（眼睛切换）
const revealed = ref(new Set());

// 关键字防抖（300ms）：输入停顿后再检索；筛选变化一律回到第 1 页
let debounceTimer = null;
function onKeywordInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { page.value = 1; load(); }, 300);
}
function onFilterChange() { page.value = 1; load(); }

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.listServices({
      q: q.value || undefined,
      type: type.value || undefined,
      env: env.value || undefined,
      enabled: enabled.value === '' ? undefined : enabled.value,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = r.rows || [];
    total.value = r.total || 0;
    types.value = r.types || [];
    envs.value = r.envs || [];
    revealed.value = new Set(); // 换页/刷新后重置明文状态
  } catch (e) {
    error.value = e.message || '加载失败，请稍后重试';
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function emptyForm() {
  return {
    id: null, name: '', svc_type: '未指定', hospital: '', vendor: '',
    username: '', password: '', env: '未指定', sort: 0,
    url: '', path: '', remark: '', enabled: true,
  };
}
function openCreate() { showPwd.value = false; form.value = emptyForm(); }
function openEdit(r) {
  showPwd.value = false;
  form.value = {
    id: r.id, name: r.name, svc_type: r.svc_type, hospital: r.hospital, vendor: r.vendor,
    username: r.username, password: r.password, env: r.env, sort: r.sort,
    url: r.url, path: r.path, remark: r.remark, enabled: !!r.enabled,
  };
}
async function save() {
  if (!form.value) return;
  if (!form.value.name.trim()) { error.value = '请填写服务名称'; return; }
  if (!String(form.value.remark || '').trim()) { error.value = '请填写备注（用途、端口、依赖、联系人等）'; return; }
  saving.value = true;
  error.value = '';
  try {
    const payload = { ...form.value, sort: Number(form.value.sort) || 0 };
    if (form.value.id) await api.updateService(form.value.id, payload);
    else await api.createService(payload);
    form.value = null;
    await load();
  } catch (e) {
    error.value = e.message || '保存失败，请稍后重试';
  } finally {
    saving.value = false;
  }
}

function toggleReveal(id) {
  const s = new Set(revealed.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  revealed.value = s;
}

// 复制到剪贴板：优先 navigator.clipboard（需安全上下文），
// 内网 http 部署时降级 textarea + execCommand（与 http://192.168.x.x 场景兼容）。
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 走降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
async function copyField(text, label) {
  if (!text) return;
  const ok = await copyText(text);
  flash(ok ? `已复制${label}` : '复制失败，请手动选择复制');
}

// 轻提示（2.2s 自动消失）
const toast = ref('');
let toastTimer = null;
function flash(msg) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, 2200);
}

function removeRow(r) {
  if (!confirm(`确认删除服务「${r.name}」？此操作不可恢复。`)) return;
  api.removeService(r.id)
    .then(load)
    .catch((e) => { error.value = e.message || '删除失败'; });
}

// 服务地址可点击（http/https 才渲染为链接）
function isHttp(u) { return /^https?:\/\/\S+$/i.test(u || ''); }

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

onMounted(load);
</script>

<template>
  <section class="svc-page">
    <header class="page-head">
      <div>
        <h1>业务服务管理</h1>
        <p class="sub">共 <b>{{ total }}</b> 项 · 登记医院各系统/服务的地址、账号、密码、路径与用途，方便查询管理</p>
      </div>
      <div class="actions" v-if="canManage">
        <button class="primary" @click="openCreate">＋ 新增业务服务</button>
      </div>
    </header>

    <div class="svc-tools">
      <input
        v-model="q"
        class="svc-search"
        type="search"
        placeholder="搜索名称 / 医院 / 厂家 / 账号 / 地址 / 路径 / 备注"
        @input="onKeywordInput"
      />
      <select v-model="type" class="svc-filter" @change="onFilterChange">
        <option value="">全部类型</option>
        <option v-for="t in types" :key="t" :value="t">{{ t }}</option>
      </select>
      <select v-model="env" class="svc-filter" @change="onFilterChange">
        <option value="">全部环境</option>
        <option v-for="e in envs" :key="e" :value="e">{{ e }}</option>
      </select>
      <select v-model="enabled" class="svc-filter" @change="onFilterChange">
        <option value="">全部状态</option>
        <option value="1">仅启用</option>
        <option value="0">仅停用</option>
      </select>
    </div>

    <p v-if="error" class="svc-error">{{ error }}</p>

    <div class="table-wrap svc-twrap">
      <table v-if="rows.length" class="svc-table">
        <thead>
          <tr>
            <th class="c-sort">序号</th>
            <th>服务名称</th>
            <th>类型</th>
            <th>医院</th>
            <th>厂家</th>
            <th>环境</th>
            <th>账号</th>
            <th>密码</th>
            <th>服务地址</th>
            <th>路径</th>
            <th>备注</th>
            <th>状态</th>
            <th v-if="canManage" class="c-ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="{ disabled: !r.enabled }">
            <td class="c-sort">{{ r.sort }}</td>
            <td class="c-name" :title="r.name">
              <b>{{ r.name }}</b>
              <span v-if="r.updated_at" class="upd" :title="'更新于 ' + fmtTime(r.updated_at)">✎</span>
            </td>
            <td><span v-if="r.svc_type && r.svc_type !== '未指定'" class="chip">{{ r.svc_type }}</span><span v-else class="dim">—</span></td>
            <td class="c-text">{{ r.hospital || '—' }}</td>
            <td class="c-text">{{ r.vendor || '—' }}</td>
            <td>
              <span class="env" :class="'env-' + r.env">{{ r.env }}</span>
            </td>
            <td class="c-text mono">{{ r.username || '—' }}</td>
            <td class="c-pwd">
              <template v-if="r.password">
                <span class="mono pwd">{{ revealed.has(r.id) ? r.password : '••••••••' }}</span>
                <button class="mini-ico" :title="revealed.has(r.id) ? '隐藏密码' : '显示密码'" @click="toggleReveal(r.id)">
                  {{ revealed.has(r.id) ? '🙈' : '👁' }}
                </button>
                <button class="mini-ico" title="复制密码" @click="copyField(r.password, '密码')">📋</button>
              </template>
              <span v-else class="dim">—</span>
            </td>
            <td class="c-text">
              <a v-if="isHttp(r.url)" :href="r.url" target="_blank" rel="noopener" class="svc-link" :title="r.url">打开</a>
              <span v-else-if="r.url" class="mono c-text" :title="r.url">{{ r.url }}</span>
              <span v-else class="dim">—</span>
            </td>
            <td class="c-text mono" :title="r.path">{{ r.path || '—' }}</td>
            <td class="c-text c-remark" :title="r.remark">{{ r.remark || '—' }}</td>
            <td>
              <span class="st" :class="r.enabled ? 'st-on' : 'st-off'">{{ r.enabled ? '启用' : '停用' }}</span>
            </td>
            <td v-if="canManage" class="c-ops">
              <button class="small" @click="openEdit(r)">编辑</button>
              <button class="small danger" @click="removeRow(r)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="!loading" class="empty">
        <div class="empty-ico">🗂</div>
        <p class="empty-title">暂无业务服务登记</p>
        <p class="empty-hint">点击右上角「新增业务服务」登记第一条系统/服务信息</p>
      </div>
      <div v-if="loading" class="empty">加载中…</div>
    </div>

    <!-- 新增 / 编辑弹窗（@click.self 不关闭，按钮关闭 —— 项目约定） -->
    <div v-if="form" class="modal-mask" @click.self="() => {}">
      <div class="modal svc-modal">
        <div class="modal-head">
          <h3>{{ form.id ? '✏️ 编辑业务服务' : '📋 新增业务服务' }}</h3>
          <button class="small" @click="form = null">✕ 关闭</button>
        </div>
        <div class="modal-body">
          <div class="grid">
            <label class="req">
              服务名称 *
              <input v-model="form.name" maxlength="255" placeholder="如：医保上传服务" />
            </label>
            <label>
              服务类型
              <select v-model="form.svc_type">
                <option v-for="t in types" :key="t" :value="t">{{ t }}</option>
              </select>
            </label>
            <label>
              医院
              <input v-model="form.hospital" maxlength="255" placeholder="留空表示通用 / 未关联" />
            </label>
            <label>
              厂家
              <input v-model="form.vendor" maxlength="255" placeholder="如：卫宁健康" />
            </label>
            <label>
              账号
              <input v-model="form.username" maxlength="255" autocomplete="off" />
            </label>
            <label>
              密码
              <span class="pwd-box">
                <input
                  v-model="form.password"
                  :type="showPwd ? 'text' : 'password'"
                  maxlength="255"
                  autocomplete="new-password"
                />
                <button class="mini-ico" :title="showPwd ? '隐藏' : '显示'" @click="showPwd = !showPwd">{{ showPwd ? '🙈' : '👁' }}</button>
                <button class="mini-ico" title="复制" @click="copyField(form.password, '密码')">📋</button>
              </span>
            </label>
            <label>
              环境
              <select v-model="form.env">
                <option v-for="e in envs" :key="e" :value="e">{{ e }}</option>
              </select>
            </label>
            <label>
              序号
              <input v-model.number="form.sort" type="number" step="1" />
            </label>
            <label class="full">
              服务地址
              <input v-model="form.url" maxlength="1000" placeholder="如：http://192.168.1.10:8080" />
            </label>
            <label class="full">
              路径
              <input v-model="form.path" maxlength="1000" placeholder="如：/api/upload 或 D:\Services\Upload" />
            </label>
            <label class="req full">
              备注 *
              <textarea v-model="form.remark" rows="3" maxlength="500" placeholder="用途、端口、依赖、联系人等补充信息（必填）"></textarea>
            </label>
          </div>
          <label class="chk-line">
            <input v-model="form.enabled" type="checkbox" />
            启用该服务
          </label>
          <p v-if="error && form" class="err">{{ error }}</p>
        </div>
        <div class="modal-actions">
          <button @click="form = null">✕ 取消</button>
          <button class="primary" :disabled="saving" @click="save">✔ {{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <div v-if="toast" class="svc-toast">{{ toast }}</div>
  </section>
</template>

<style scoped>
.svc-page { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
/* .modal-body 全局为 flex 列：overflow 受限子块必须 flex:none（v1.18.63 教训） */
.svc-tools { display: flex; gap: 8px; flex-wrap: wrap; flex: none; }
.svc-search { flex: 1 1 260px; max-width: 420px; padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: 9px; }
.svc-filter { padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: 9px; background: #fff; }
.svc-error { margin: 0; color: var(--danger); font-size: 12.5px; }
.svc-twrap { flex: none; border: 1px solid var(--border); border-radius: 12px; overflow: auto; background: #fff; }
.svc-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 1180px; }
.svc-table th, .svc-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; white-space: nowrap; }
.svc-table thead th { background: var(--panel-2); color: #64748b; font-weight: 600; font-size: 12px; position: sticky; top: 0; z-index: 1; }
.svc-table tbody tr:hover { background: var(--panel-2); }
.svc-table tbody tr.disabled { opacity: .55; }
.c-sort { width: 52px; color: var(--muted); }
.c-name b { font-weight: 600; }
.c-name .upd { margin-left: 6px; font-size: 11px; color: var(--muted); }
.c-text { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.c-remark { max-width: 260px; white-space: normal; }
.c-ops { width: 118px; }
.c-ops button + button { margin-left: 6px; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
.dim { color: var(--muted); }
.chip { display: inline-block; padding: 2px 9px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--border); font-size: 12px; }
.env { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; border: 1px solid transparent; }
.env-生产 { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
.env-灰度 { background: #fffbeb; color: #b45309; border-color: #fde68a; }
.env-测试 { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
.env-开发 { background: #f0fdf4; color: #15803d; border-color: #bbf7d0; }
.env-未指定 { background: var(--panel-2); color: var(--muted); border-color: var(--border); }
.c-pwd .pwd { min-width: 72px; display: inline-block; }
.mini-ico { border: none; background: transparent; padding: 2px 3px; font-size: 13px; cursor: pointer; line-height: 1; }
.mini-ico:hover { background: var(--panel-2); border-radius: 6px; }
.svc-link { color: var(--primary); text-decoration: none; font-weight: 600; }
.svc-link:hover { text-decoration: underline; }
.st { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; }
.st-on { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
.st-off { background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); }
/* 弹窗 */
.svc-modal { width: 640px; }
.svc-modal .modal-body { max-height: 62vh; overflow: auto; flex: none; }
.req :deep(input) { border-color: #93b4f5; }
.pwd-box { display: flex; align-items: center; gap: 4px; }
.pwd-box input { flex: 1; min-width: 0; }
.chk-line { display: flex !important; flex-direction: row !important; align-items: center; gap: 8px !important; font-size: 13px !important; color: var(--text) !important; }
/* 轻提示 */
.svc-toast {
  position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
  background: #0f172a; color: #fff; padding: 9px 18px; border-radius: 999px;
  font-size: 13px; box-shadow: 0 6px 24px rgba(15, 23, 42, .35); z-index: 90;
}
</style>
