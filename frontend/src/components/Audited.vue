<script setup>
// 「审核通过」视图（v1.2 新增）：
// 对每个登录用户常显（不走菜单权限），只展示审核状态=已通过 的问题。
// 复用 ProblemList 展示（只读，不提供编辑/删除/审核入口），点击行查看详情。
import { ref, onMounted } from 'vue';
import { api } from '../api.js';
import ProblemList from './ProblemList.vue';

const props = defineProps({
  // 是否具备「审核问题」功能权限：具备时本视图也允许对“已通过”问题再次审核
  // （再次审核=覆盖式，不通过即把该问题移出“审核通过”菜单）。
  canAudit: { type: Boolean, default: false },
});

const emit = defineEmits(['view']);

const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const keyword = ref('');
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const params = {
      auditStatus: '已通过',
      keyword: keyword.value || undefined,
      sort: 'audit_at',
      order: 'desc',
      page: page.value,
      pageSize: pageSize.value,
    };
    const r = await api.list(params);
    rows.value = r.rows || [];
    total.value = r.total || 0;
  } catch (e) {
    error.value = e.message || '加载失败，请稍后重试';
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function search() { page.value = 1; load(); }
function changePage(p) { page.value = p; load(); }
function changePageSize(n) { pageSize.value = n; page.value = 1; load(); }

// v1.18.24：导出「底稿登记清单」xlsx（供信息科到卫宁底稿系统登记底稿）。
// 与列表同 keyword；空结果不发起请求，直接提示。
const exporting = ref(false);
async function exportDraft() {
  if (exporting.value) return;
  if (!total.value) { showToast('当前没有已通过的问题可导出', 'error'); return; }
  exporting.value = true;
  try {
    const blob = await api.exportDraftBlob({ keyword: keyword.value || undefined });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'draft_register.xlsx';
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出底稿登记清单');
  } catch (e) {
    showToast(e.message || '导出失败', 'error');
  } finally {
    exporting.value = false;
  }
}

// 轻量 toast（与 CiteToChat 同款交互）：2.5s 自动消失
const toast = ref({ show: false, text: '', kind: 'success' });
let toastTimer = null;
function showToast(text, kind = 'success') {
  toast.value = { show: true, text, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 2500);
}

onMounted(load);
</script>

<template>
  <section>
    <header class="page-head">
      <div>
        <h1>审核通过</h1>
        <p class="sub">已通过审核的问题（按审核时间倒序）</p>
      </div>
      <div class="actions">
        <div class="audit-search">
          <input
            v-model="keyword"
            type="search"
            placeholder="搜索标题 / 科室 / 提出人 / 登记人…"
            @keyup.enter="search"
          />
          <button class="small primary" :disabled="loading" @click="search">搜索</button>
        </div>
        <!-- v1.18.24：导出底稿登记清单（图标与交互样式对齐 ExportButtons 的导出按钮） -->
        <button class="small draft-export-btn" :disabled="exporting" @click="exportDraft">
          <svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3.5v11M7.5 10.2 12 14.7l4.5-4.5" />
            <path d="M4.5 17.5v1.6a1.4 1.4 0 0 0 1.4 1.4h12.2a1.4 1.4 0 0 0 1.4-1.4v-1.6" />
          </svg>{{ exporting ? '导出中…' : '导出底稿登记' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="audit-load-error">{{ error }}</p>

    <ProblemList
      :rows="rows"
      :total="total"
      :page="page"
      :page-size="pageSize"
      :can-edit="false"
      :can-delete="false"
      :can-audit="canAudit"
      :selectable="false"
      sort-by="audit_at"
      sort-order="desc"
      :selected="[]"
      @view="(r) => emit('view', r)"
      @audited="load"
      @page="changePage"
      @page-size="changePageSize"
    />

    <!-- 轻量 toast（v1.18.24）：导出结果即时反馈 -->
    <transition name="audit-toast-fade">
      <div v-if="toast.show" class="audit-toast" :class="'audit-toast-' + toast.kind" role="status">{{ toast.text }}</div>
    </transition>
  </section>
</template>

<style scoped>
.audit-search { display: flex; gap: 8px; align-items: center; }
.audit-search input {
  width: 260px; padding: 8px 12px; font-size: 13px;
  border: 1px solid var(--border-strong); border-radius: 9px; background: #fff; color: var(--text);
}
.audit-load-error { color: #b91c1c; font-size: 13px; margin: 0 0 10px; }
.actions { display: flex; gap: 10px; align-items: center; }
.draft-export-btn { display: inline-flex; gap: 6px; align-items: center; }

/* 轻量 toast（v1.18.24）：导出成功 / 失败即时反馈 */
.audit-toast {
  position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%); z-index: 200;
  background: #0f172a; color: #fff; font-size: 13px; padding: 9px 16px; border-radius: 10px;
  box-shadow: var(--shadow-lg);
}
.audit-toast-error { background: #b91c1c; }
.audit-toast-fade-enter-active, .audit-toast-fade-leave-active { transition: opacity .2s; }
.audit-toast-fade-enter-from, .audit-toast-fade-leave-to { opacity: 0; }
</style>
