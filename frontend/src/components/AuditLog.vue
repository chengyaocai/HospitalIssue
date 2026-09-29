<script setup>
import { ref, computed, onMounted } from 'vue';
import { api, ACTION_LABELS } from '../api.js';

const rows = ref([]);
const total = ref(0);
const error = ref('');
const page = ref(1);
const pageSize = 20;

const filters = ref({ action: '', username: '', from: '', to: '' });

// 操作类型下拉：与 api.js 的 ACTION_LABELS（后端同款映射）保持一致，v1.2 起全部中文化
const ACTIONS = Object.entries(ACTION_LABELS).map(([v, t]) => ({ v, t }));
const LABELS = ACTION_LABELS;

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

async function load() {
  error.value = '';
  try {
    const d = await api.listAudit({ ...filters.value, page: page.value, pageSize });
    rows.value = d.rows;
    total.value = d.total;
  } catch (e) {
    error.value = e.message;
  }
}
function search() { page.value = 1; load(); }
function resetFilter() { filters.value = { action: '', username: '', from: '', to: '' }; page.value = 1; load(); }
function go(p) { page.value = p; load(); }
async function exportFile(format) {
  try {
    const blob = await api.auditExportBlob({ ...filters.value, format });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = format === 'csv' ? 'audit_log.csv' : 'audit_log.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(e.message || '导出失败');
  }
}
function fmt(t) { return t ? new Date(t).toLocaleString('zh-CN') : ''; }
onMounted(load);
</script>

<template>
  <section>
    <header class="page-head">
      <h1>操作日志</h1>
      <div class="actions">
        <button @click="exportFile('xlsx')">
          <svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3.5v11M7.5 10.2 12 14.7l4.5-4.5" />
            <path d="M4.5 17.5v1.6a1.4 1.4 0 0 0 1.4 1.4h12.2a1.4 1.4 0 0 0 1.4-1.4v-1.6" />
          </svg>导出 Excel
        </button>
        <button @click="exportFile('csv')">
          <svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3.5v11M7.5 10.2 12 14.7l4.5-4.5" />
            <path d="M4.5 17.5v1.6a1.4 1.4 0 0 0 1.4 1.4h12.2a1.4 1.4 0 0 0 1.4-1.4v-1.6" />
          </svg>导出 CSV
        </button>
      </div>
    </header>

    <div class="filterbar">
      <label class="field">
        <span>操作类型</span>
        <select v-model="filters.action">
          <option value="">全部操作</option>
          <option v-for="a in ACTIONS" :key="a.v" :value="a.v">{{ a.t }}</option>
        </select>
      </label>
      <label class="field">
        <span>操作人</span>
        <input v-model="filters.username" placeholder="用户名" @keyup.enter="search" />
      </label>
      <label class="field">
        <span>起始日期</span>
        <input type="date" v-model="filters.from" />
      </label>
      <label class="field">
        <span>截止日期</span>
        <input type="date" v-model="filters.to" />
      </label>
      <div class="field-actions">
        <button class="primary" @click="search">查询</button>
        <button @click="resetFilter">重置</button>
      </div>
    </div>

    <p v-if="error" class="err">{{ error }}</p>

    <div class="list">
      <div class="list-head">
        <h3>日志明细</h3>
        <span class="count">共 <b>{{ total }}</b> 条记录</span>
      </div>
      <div class="table-wrap">
        <table>
        <thead>
          <tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>详情</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="col-time">{{ fmt(r.created_at) }}</td>
            <td>{{ r.username }}</td>
            <td>{{ LABELS[r.action] || r.action }}</td>
            <td>{{ r.target }}</td>
            <td class="detail">{{ r.detail }}</td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="5" class="empty">
              <div class="empty-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
                  <path d="M3.6 4.6V9h4.4" />
                  <path d="M12 8.2V12l3 1.9" />
                </svg>
              </div>
              <p class="empty-title">暂无日志</p>
              <p class="empty-hint">当前筛选条件下没有匹配的操作记录</p>
            </td>
          </tr>
        </tbody>
        </table>
      </div>
      <div class="pager">
        <span class="pager-info">共 <b>{{ total }}</b> 条 · 第 <b>{{ page }}</b> / {{ totalPages }} 页</span>
        <div class="pager-btns">
          <button class="small" :disabled="page <= 1" @click="go(page - 1)">上一页</button>
          <button class="small" :disabled="page >= totalPages" @click="go(page + 1)">下一页</button>
        </div>
      </div>
    </div>
  </section>
</template>
