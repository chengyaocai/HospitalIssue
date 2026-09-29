<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api, EXPORT_FIELDS } from '../api.js';

const props = defineProps({ filters: Object });

// 可选的导出字段（key 与后端 export.js 的 EXPORT_COLUMNS 对应）
const FIELDS = EXPORT_FIELDS;
const KEY = 'issue_tracker_export_fields';
const selected = ref([]);

function loadSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (Array.isArray(saved)) { selected.value = FIELDS.filter((f) => saved.includes(f.key)).map((f) => f.key); return; }
  } catch { /* 忽略损坏配置 */ }
  selected.value = FIELDS.map((f) => f.key);
}
function persist() { localStorage.setItem(KEY, JSON.stringify(selected.value)); }
onMounted(loadSelection);

const showMenu = ref(false);
const menuRef = ref(null);
function toggleMenu() { showMenu.value = !showMenu.value; }
function onDocClick(e) {
  if (showMenu.value && menuRef.value && !menuRef.value.contains(e.target)) showMenu.value = false;
}
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));

function toggleField(key) {
  const set = new Set(selected.value);
  if (set.has(key)) set.delete(key); else set.add(key);
  selected.value = FIELDS.filter((f) => set.has(f.key)).map((f) => f.key);
  persist();
}
function allChecked() { return selected.value.length === FIELDS.length; }
function toggleAll() { selected.value = allChecked() ? [] : FIELDS.map((f) => f.key); persist(); }

async function exportFile(format) {
  if (!selected.value.length) { alert('请至少选择一个导出字段'); return; }
  const params = { format };
  for (const [k, v] of Object.entries(props.filters || {})) if (v) params[k] = v;
  params.fields = selected.value;
  try {
    const blob = await api.exportBlob(params);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = format === 'csv' ? 'software_issues.csv' : 'software_issues.xlsx';
    a.click();
    URL.revokeObjectURL(url);
    showMenu.value = false;
  } catch (e) {
    alert(e.message || '导出失败');
  }
}
</script>

<template>
  <div class="export-wrap" ref="menuRef">
    <button class="small" @click.stop="toggleMenu">
      <svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3.5v11M7.5 10.2 12 14.7l4.5-4.5" />
        <path d="M4.5 17.5v1.6a1.4 1.4 0 0 0 1.4 1.4h12.2a1.4 1.4 0 0 0 1.4-1.4v-1.6" />
      </svg>导出
    </button>
    <div v-if="showMenu" class="export-pop">
      <div class="export-pop-head">
        <span>选择导出字段</span>
        <label class="mini-check">
          <input type="checkbox" :checked="allChecked()" @change="toggleAll" /> 全选
        </label>
      </div>
      <div class="export-fields">
        <label v-for="f in FIELDS" :key="f.key" :class="{ disabled: f.always }">
          <input type="checkbox" :checked="selected.includes(f.key)" :disabled="f.always" @change="toggleField(f.key)" />
          {{ f.label }}
        </label>
      </div>
      <div class="export-acts">
        <button class="small primary" @click="exportFile('xlsx')">导出 Excel</button>
        <button class="small" @click="exportFile('csv')">导出 CSV</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.export-wrap { position: relative; }
.export-pop {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 30;
  width: 240px; background: #fff; border: 1px solid var(--border);
  border-radius: 12px; box-shadow: var(--shadow); padding: 10px;
}
.export-pop-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12.5px; color: var(--muted); margin-bottom: 8px;
}
.mini-check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font-size: 12px; }
.export-fields {
  display: grid; grid-template-columns: 1fr 1fr; gap: 2px 10px;
  max-height: 220px; overflow: auto; padding: 4px 2px;
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
}
.export-fields label {
  display: flex; align-items: center; gap: 7px; font-size: 13px;
  color: var(--text); padding: 5px 4px; border-radius: 7px; cursor: pointer;
}
.export-fields label:hover { background: var(--panel-2); }
.export-fields input { accent-color: var(--primary); cursor: pointer; }
.export-fields label.disabled { color: var(--muted); cursor: not-allowed; }
.export-acts { display: flex; gap: 8px; margin-top: 10px; }
.export-acts button { flex: 1; }
</style>
