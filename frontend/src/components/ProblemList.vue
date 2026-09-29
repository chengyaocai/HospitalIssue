<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  rows: Array, total: Number, page: Number, pageSize: Number, canDelete: Boolean, canEdit: Boolean,
  canAudit: Boolean, canCite: Boolean,
  selectable: { type: Boolean, default: true },
  recycle: { type: Boolean, default: false },   // 回收站视图（v1.6 软删除）
  sortBy: String, sortOrder: String, selected: Array,
});
const emit = defineEmits(['edit', 'delete', 'page', 'view', 'sort', 'pageSize', 'toggle', 'toggleAll', 'audited', 'restore', 'hardDelete', 'cite']);

const PAGE_SIZES = [10, 20, 50];

const selectedSet = computed(() => new Set((props.selected || []).map(String)));
const allChecked = computed(() => props.rows.length > 0 && props.rows.every((r) => selectedSet.value.has(String(r.id))));
const someChecked = computed(() => (props.selected || []).length > 0 && !allChecked.value);
function onToggleAll(e) {
  emit('toggleAll', e.target.checked ? props.rows.map((r) => r.id) : []);
}

// always=true 的列不可隐藏；附件列不可排序（是数组）
const COLUMNS = [
  { key: 'id', label: 'ID', cls: 'col-id', sortable: true },
  { key: 'title', label: '标题', cls: 'col-title', always: true, sortable: true },
  { key: 'department', label: '科室', sortable: true },
  { key: 'reporter', label: '提出人', sortable: true },
  { key: 'registrar', label: '登记人', sortable: true },
  { key: 'softwareSystem', label: '软件系统', sortable: true },
  { key: 'type', label: '类型', sortable: true },
  { key: 'severity', label: '严重程度', sortable: true },
  { key: 'status', label: '状态', always: true, sortable: true },
  { key: 'audit_status', label: '审核状态' },
  { key: 'satisfaction', label: '满意度', cls: 'col-sat' },
  { key: 'attachments', label: '附件', cls: 'col-att' },
  { key: 'created_at', label: '登记时间', cls: 'col-time', sortable: true },
];
const COL_KEY = 'issue_tracker_columns';

function loadVisible() {
  try {
    const saved = JSON.parse(localStorage.getItem(COL_KEY) || 'null');
    if (Array.isArray(saved)) {
      return COLUMNS.filter((c) => c.always || saved.includes(c.key)).map((c) => c.key);
    }
  } catch { /* 忽略损坏的本地配置 */ }
  return COLUMNS.map((c) => c.key);
}
const visible = ref(loadVisible());
const cols = computed(() => COLUMNS.filter((c) => visible.value.includes(c.key)));
// 勾选列（按权限可选）+ 操作列（无编辑/删除/审核/引用权限时整列隐藏）
const showOps = computed(() => props.canEdit === true || props.canDelete === true || props.canAudit === true || props.canCite === true);
const colSpan = computed(() => cols.value.length + (props.selectable ? 1 : 0) + (showOps.value ? 1 : 0));

const showColMenu = ref(false);
const colMenuRef = ref(null);
function toggleCol(key) {
  const set = new Set(visible.value);
  if (set.has(key)) set.delete(key); else set.add(key);
  visible.value = COLUMNS.filter((c) => c.always || set.has(c.key)).map((c) => c.key);
  localStorage.setItem(COL_KEY, JSON.stringify(visible.value));
}
function resetCols() {
  visible.value = COLUMNS.map((c) => c.key);
  localStorage.setItem(COL_KEY, JSON.stringify(visible.value));
}
function onDocClick(e) {
  if (showColMenu.value && colMenuRef.value && !colMenuRef.value.contains(e.target)) showColMenu.value = false;
  if (opsOpenId.value != null) opsOpenId.value = null;   // ops 菜单内部点击已被 .stop 挡住，不会走到这里
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  window.addEventListener('scroll', onWinScroll, true);
  window.addEventListener('resize', onWinScroll);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  window.removeEventListener('scroll', onWinScroll, true);
  window.removeEventListener('resize', onWinScroll);
});

// ---- 行内操作下拉（v1.18.23）：操作列只留一个「操作 ▾」按钮，菜单项按权限显隐 ----
// 菜单用 position:fixed（按按钮 rect 计算），避免被 .table-wrap 的 overflow 裁剪；
// 打开期间滚动/缩放即收起，防止 fixed 坐标失准。
const OPS_MENU_W = 132;
const opsOpenId = ref(null);
const opsPos = ref({ top: 0, left: 0 });
function toggleOps(r, e) {
  if (opsOpenId.value === r.id) { opsOpenId.value = null; return; }
  const rect = e.currentTarget.getBoundingClientRect();
  opsPos.value = {
    top: rect.bottom + 4,
    left: Math.max(8, Math.min(rect.right - OPS_MENU_W, window.innerWidth - OPS_MENU_W - 8)),
  };
  opsOpenId.value = r.id;
}
function doOps(fn) { opsOpenId.value = null; fn(); }
function onWinScroll() { opsOpenId.value = null; }

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
function fmt(t) { return t ? new Date(t).toLocaleString('zh-CN') : ''; }
function attCount(r) { return Array.isArray(r.attachments) ? r.attachments.length : 0; }
function cellText(r, key) {
  if (key === 'attachments') return attCount(r) ? attCount(r) + ' 个' : '—';
  if (key === 'created_at') return fmt(r.created_at);
  return r[key];
}
function nextOrder(col) {
  if (props.sortBy === col.key) return props.sortOrder === 'asc' ? 'desc' : 'asc';
  return ['id', 'created_at'].includes(col.key) ? 'desc' : 'asc';
}
function onHeadClick(col) {
  if (!col.sortable) return;
  emit('sort', { by: col.key, order: nextOrder(col) });
}

// ---- 审核（需 issue.audit 权限；通过无需原因，不通过必须填写原因；允许重复审核覆盖）----
const auditTarget = ref(null);      // 当前正在审核的问题行
const auditMode = ref('approve');   // 'approve' | 'reject'
const auditReason = ref('');
const auditError = ref('');
const auditBusy = ref(false);
function auditBadgeClass(v) {
  if (v === '已通过') return 'audit-pass';
  if (v === '不通过') return 'audit-reject';
  return 'audit-pending';           // 待审核 / 旧数据缺省
}
function openAudit(r) {
  auditTarget.value = r;
  auditMode.value = 'approve';
  auditReason.value = r.audit_status === '不通过' ? '' : (r.audit_reason || '');
  auditError.value = '';
}
function closeAudit() { auditTarget.value = null; auditError.value = ''; }
async function submitAudit() {
  if (!auditTarget.value || auditBusy.value) return;
  const result = auditMode.value;
  const reason = auditReason.value.trim();
  if (result === 'reject' && !reason) {
    auditError.value = '请填写不通过原因';
    return;
  }
  auditBusy.value = true;
  auditError.value = '';
  try {
    await api.auditIssue(auditTarget.value.id, { result, reason });
    closeAudit();
    emit('audited');   // 通知父级刷新列表
  } catch (e) {
    auditError.value = e.message || '审核失败，请稍后重试';
  } finally {
    auditBusy.value = false;
  }
}
</script>

<template>
  <div class="list">
    <div class="list-head">
      <h3>{{ recycle ? '回收站' : '问题列表' }}</h3>
      <div class="list-tools">
        <span class="count">共 <b>{{ total }}</b> 条{{ recycle ? '已删除记录' : '记录' }}</span>
        <div class="col-menu" ref="colMenuRef">
          <button class="small" @click.stop="showColMenu = !showColMenu">
            <svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
              <circle cx="9" cy="7" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="17" r="2" />
            </svg>列设置
          </button>
          <div v-if="showColMenu" class="col-pop">
            <label v-for="c in COLUMNS" :key="c.key" :class="{ disabled: c.always }">
              <input type="checkbox" :checked="visible.includes(c.key)" :disabled="c.always" @change="toggleCol(c.key)" />
              {{ c.label }}
            </label>
            <p class="col-pop-tip">标题 / 状态 / 操作 始终显示</p>
            <button class="small" @click="resetCols">恢复默认</button>
          </div>
        </div>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th v-if="selectable" class="col-check">
              <input type="checkbox" :checked="allChecked" :indeterminate="someChecked" title="全选本页" @change="onToggleAll" />
            </th>
            <th
              v-for="c in cols"
              :key="c.key"
              :class="[c.cls, { sortable: c.sortable, sorted: sortBy === c.key }]"
              @click="onHeadClick(c)"
            >
              {{ c.label }}<span class="sort-ind">{{ sortBy === c.key ? (sortOrder === 'asc' ? '▲' : '▼') : '' }}</span>
            </th>
            <th v-if="showOps" class="col-ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" class="row-click" title="点击查看详情" @click="emit('view', r)">
            <td v-if="selectable" class="col-check">
              <input type="checkbox" :checked="selectedSet.has(String(r.id))" @click.stop @change="emit('toggle', r.id)" />
            </td>
            <td v-for="c in cols" :key="c.key" :class="c.cls">
              <span v-if="c.key === 'severity'" class="sev" :class="'sev-' + r.severity">{{ r.severity }}</span>
              <span v-else-if="c.key === 'status'" class="st" :class="'st-' + r.status">{{ r.status }}</span>
              <span v-else-if="c.key === 'audit_status'" class="audit-badge" :class="auditBadgeClass(r.audit_status)">{{ r.audit_status || '待审核' }}</span>
              <span v-else-if="c.key === 'satisfaction'">
                <span v-if="r.satisfaction" class="sat" :class="{ 'sat-good': r.satisfaction === '满意', 'sat-mid': r.satisfaction === '一般', 'sat-bad': r.satisfaction === '不满意' }">{{ r.satisfaction }}</span>
                <span v-else class="sat-none">—</span>
              </span>
              <span v-else-if="c.key === 'title'" class="cell-title">{{ r.title }}</span>
              <template v-else>{{ cellText(r, c.key) }}</template>
            </td>
            <td v-if="showOps" class="col-ops">
              <!-- 回收站视图：仅「恢复 / 彻底删除」（彻底删除需二次确认，见父级） -->
              <template v-if="recycle">
                <button v-if="canDelete" class="small" @click.stop="emit('restore', r)">恢复</button>
                <button v-if="canDelete" class="small danger" @click.stop="emit('hardDelete', r)">彻底删除</button>
              </template>
              <!-- v1.18.23：操作收敛为单个「操作 ▾」下拉，避免一行四个按钮过于拥挤；
                   菜单项按权限显隐，fixed 定位防 .table-wrap 裁剪 -->
              <div v-else class="ops-wrap" @click.stop>
                <button class="small ops-btn" @click.stop="toggleOps(r, $event)">
                  操作
                  <svg class="ops-chev" :class="{ up: opsOpenId === r.id }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6" /></svg>
                </button>
                <div v-if="opsOpenId === r.id" class="ops-menu" :style="{ top: opsPos.top + 'px', left: opsPos.left + 'px' }">
                  <button v-if="canCite" class="ops-item" @click="doOps(() => emit('cite', r))">引用</button>
                  <button v-if="canAudit" class="ops-item" @click="doOps(() => openAudit(r))">审核</button>
                  <button v-if="canEdit" class="ops-item" @click="doOps(() => emit('edit', r))">编辑</button>
                  <button v-if="canDelete" class="ops-item danger" @click="doOps(() => emit('delete', r))">删除</button>
                </div>
              </div>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="colSpan" class="empty">
              <div class="empty-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="4.5" y="3.5" width="15" height="17" rx="2.5" />
                  <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
                </svg>
              </div>
              <p class="empty-title">暂无登记的问题</p>
              <p class="empty-hint">点击右上角「+ 登记问题」开始登记第一条记录</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <div class="pager-left">
        <span class="pager-info">共 <b>{{ total }}</b> 条 · 第 <b>{{ page }}</b> / {{ totalPages }} 页</span>
        <label class="page-size">每页
          <select :value="pageSize" @change="emit('pageSize', Number($event.target.value))">
            <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
          </select>条
        </label>
      </div>
      <div class="pager-btns">
        <button class="small" :disabled="page <= 1" @click="emit('page', page - 1)">上一页</button>
        <button class="small" :disabled="page >= totalPages" @click="emit('page', page + 1)">下一页</button>
      </div>
    </div>

    <!-- 审核弹框：通过无需原因；不通过必须填写原因；允许重复审核覆盖 -->
    <div v-if="auditTarget" class="modal-mask">
      <div class="modal audit-modal">
        <div class="modal-head">
          <h3>审核问题</h3>
          <button class="icon-btn" title="关闭" @click="closeAudit">✕</button>
        </div>
        <div class="modal-body">
          <p class="audit-target">「{{ auditTarget.title }}」<span class="audit-target-meta">{{ auditTarget.department }} · {{ auditTarget.reporter }}</span></p>
          <div class="audit-mode">
            <label :class="{ picked: auditMode === 'approve' }">
              <input type="radio" value="approve" v-model="auditMode" /> 审核通过
            </label>
            <label :class="{ picked: auditMode === 'reject' }">
              <input type="radio" value="reject" v-model="auditMode" /> 审核不通过
            </label>
          </div>
          <label class="audit-reason-label">
            审核意见{{ auditMode === 'reject' ? '（必填）' : '（选填，通过时可留空）' }}
            <textarea
              v-model="auditReason"
              rows="4"
              maxlength="200"
              :placeholder="auditMode === 'reject' ? '请填写不通过原因（必填，不超过 200 字）' : '可填写补充说明（选填）'"
            ></textarea>
          </label>
          <p v-if="auditError" class="audit-error">{{ auditError }}</p>
        </div>
        <div class="modal-foot">
          <button class="small" @click="closeAudit">取消</button>
          <button class="small primary" :disabled="auditBusy" @click="submitAudit">
            {{ auditBusy ? '提交中…' : (auditMode === 'approve' ? '确认通过' : '确认不通过') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
