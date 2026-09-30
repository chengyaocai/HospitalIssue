<script setup>
import { reactive, ref, onMounted, onUnmounted, watch } from 'vue';
import { STATUSES, TYPES, DEPARTMENTS } from '../api.js';

const props = defineProps({ filters: Object, recycle: Boolean });
const emit = defineEmits(['filter', 'search', 'toggleRecycle']);

// 多选筛选（v1.18.45）：状态 / 类型 / 科室 改为「勾选式多选下拉」，支持组合筛选。
// form 三个字段为数组（空数组=不过滤）；关键字仍为文本。
// 提交给后端的查询串由 qs() 把数组序列化为逗号分隔多值（status=待处理,处理中），
// 后端 parseQuery 拆分为数组、两个仓储按 IN / includes 过滤；单值查询完全向后兼容。
const form = reactive({ status: [], type: [], department: [], keyword: '' });

// v1.18.47：勾选即生效 —— checkbox 变更后 350ms 防抖自动提交筛选（Excel 筛选器交互），
// 「清除」也立即生效；「应用 / 搜索」保留照常工作。
const MS_FILTER_DEBOUNCE = 350;
let autoTimer = null;
function submitNow() {
  clearTimeout(autoTimer);
  autoTimer = null;
  openKey.value = '';
  emit('filter', { ...form });
}
function submitDebounced() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    emit('filter', { ...form });
  }, MS_FILTER_DEBOUNCE);
}
watch(() => form.status, submitDebounced, { deep: true });
watch(() => form.type, submitDebounced, { deep: true });
watch(() => form.department, submitDebounced, { deep: true });

// 三个多选下拉的字段配置（模板里 v-for 渲染同一段结构）
const MS_FIELDS = [
  { key: 'status', label: '状态', all: '全部状态', options: STATUSES },
  { key: 'type', label: '类型', all: '全部类型', options: TYPES },
  { key: 'department', label: '科室', all: '全部科室', options: DEPARTMENTS },
];

// 弹层开合：同一时间只开一个；点击组件外自动收起
const openKey = ref('');
function toggle(key) { openKey.value = openKey.value === key ? '' : key; }
function onDocClick() { openKey.value = ''; }
onMounted(() => document.addEventListener('click', onDocClick));
onUnmounted(() => document.removeEventListener('click', onDocClick));

// 按钮文案：未选=全部X；恰为全部选项=全部X；1 个=该值；2 个=A / B；更多=已选 N 项
function summary(f) {
  const picked = form[f.key];
  if (!picked.length || picked.length === f.options.length) return f.all;
  if (picked.length === 1) return picked[0];
  if (picked.length === 2) return `${picked[0]} / ${picked[1]}`;
  return `已选 ${picked.length} 项`;
}

function clearOne(key) { form[key] = []; submitNow(); }
function apply() { submitNow(); }
function reset() {
  form.status = []; form.type = []; form.department = []; form.keyword = '';
  submitNow();
}
</script>

<template>
  <div class="filterbar">
    <div v-for="f in MS_FIELDS" :key="f.key" class="field">
      <span>{{ f.label }}</span>
      <div class="ms" @click.stop>
        <button type="button" class="ms-btn" :class="{ active: form[f.key].length }" @click="toggle(f.key)">
          <span class="ms-label">{{ summary(f) }}</span>
          <svg class="ms-chev" :class="{ up: openKey === f.key }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6" /></svg>
        </button>
        <div v-if="openKey === f.key" class="ms-pop" data-auto-submit="v1.18.47-filter-auto-submit">
          <label v-for="opt in f.options" :key="opt" class="ms-item">
            <input type="checkbox" :value="opt" v-model="form[f.key]">
            <span>{{ opt }}</span>
          </label>
          <div class="ms-foot">
            <button type="button" class="ms-mini" @click="clearOne(f.key)">清除</button>
            <button type="button" class="ms-mini primary" @click="apply">应用</button>
          </div>
        </div>
      </div>
    </div>
    <label class="field grow">
      <span>关键字</span>
      <input v-model="form.keyword" placeholder="标题 / 提出人 / 登记人 / 描述" @keyup.enter="apply" />
    </label>
    <div class="field-actions">
      <!-- 回收站切换（v1.6 软删除）：勾上后仅查看已删除问题，可恢复 / 彻底删除 -->
      <button
        class="recycle-toggle"
        :class="{ active: recycle }"
        :title="recycle ? '退出回收站，返回正常列表' : '查看已删除的问题（回收站）'"
        @click="emit('toggleRecycle')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.8 12.2a1.8 1.8 0 0 0 1.8 1.6h5.8a1.8 1.8 0 0 0 1.8-1.6L17.5 7" />
          <path d="M10 11v6M14 11v6" />
        </svg>
        回收站
      </button>
      <button class="primary" @click="apply">搜索</button>
      <button @click="reset">重置</button>
    </div>
  </div>
</template>

<style scoped>
/* 多选下拉（v1.18.45）：按钮 + 勾选弹层；替换原 <select>（原生多选体验差）。
   复用全局 .field 布局（label 文案 + 控件），仅新增 .ms* 系列 scoped 样式。 */
.ms { position: relative; }
.ms-btn {
  display: inline-flex; align-items: center; gap: 6px;
  min-width: 118px; height: 34px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--panel); color: var(--text);
  font-size: 13px; cursor: pointer; text-align: left;
}
.ms-btn:hover { border-color: var(--primary); }
.ms-btn.active { border-color: var(--primary); color: var(--primary); }
.ms-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-chev { width: 14px; height: 14px; margin-left: auto; flex: 0 0 auto; transition: transform 0.15s; }
.ms-chev.up { transform: rotate(180deg); }
.ms-pop {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 70;
  min-width: 168px; max-height: 262px; overflow: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(15, 35, 95, 0.14);
  padding: 6px;
}
.ms-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 6px;
  font-size: 13px; color: var(--text);
  cursor: pointer; white-space: nowrap;
}
.ms-item:hover { background: rgba(59, 116, 246, 0.08); }
/* ⚠️ 全局 .field input / .filterbar input 会把文本框样式（width:100%/min-height:36px/padding）
   套到弹层 checkbox 上——必须显式还原原生 checkbox 形态，否则方块拉大、错位 */
.ms-item input[type='checkbox'] {
  width: 14px; height: 14px; min-height: 0; width: 14px;
  padding: 0; margin: 0; flex: 0 0 auto;
  accent-color: var(--primary); cursor: pointer;
}
.ms-foot {
  display: flex; justify-content: flex-end; gap: 6px;
  border-top: 1px solid var(--border);
  margin-top: 4px; padding-top: 6px;
}
.ms-mini {
  font-size: 12px; padding: 3px 10px; border-radius: 6px;
  border: 1px solid var(--border); background: transparent;
  color: var(--text); cursor: pointer;
}
.ms-mini.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
</style>
