<script setup>
import { computed } from 'vue';

// 横向条形列表：用于科室 / 类型 / 严重程度 / 软件系统 / 处理人等维度的复用。
// items: [{ label, count }]；max 设定时超出的条目会聚合为「其他」。
const props = defineProps({
  items: { type: Array, default: () => [] },
  color: { type: String, default: '#2563eb' },
  max: { type: Number, default: 0 },          // 0 表示不限制
  colorByIndex: { type: Array, default: () => [] }, // 可选：按展示顺序取色
  othersLabel: { type: String, default: '其他' },
});

const shown = computed(() => {
  const arr = (props.items || []).map((it) => ({ label: it.label, count: Number(it.count) || 0 }));
  if (!props.max || arr.length <= props.max) return arr;
  const head = arr.slice(0, props.max - 1);
  const rest = arr.slice(props.max - 1).reduce((s, it) => s + it.count, 0);
  if (rest > 0) head.push({ label: props.othersLabel, count: rest });
  return head;
});

const maxCount = computed(() => Math.max(1, ...shown.value.map((it) => it.count)));
function pct(v) { return Math.round((v / maxCount.value) * 100); }
function colorOf(i) { return props.colorByIndex[i] || props.color; }
</script>

<template>
  <div v-if="shown.length" class="barlist">
    <div v-for="(it, i) in shown" :key="it.label" class="bar-row">
      <span class="bar-label" :title="it.label">{{ it.label }}</span>
      <div class="bar-track">
        <div class="bar-fill" :style="{ width: pct(it.count) + '%', background: colorOf(i) }"></div>
      </div>
      <span class="bar-val">{{ it.count }}</span>
    </div>
  </div>
  <p v-else class="chart-empty">暂无数据</p>
</template>

<style scoped>
.barlist { display: flex; flex-direction: column; gap: 10px; }
.bar-row { display: flex; align-items: center; gap: 10px; }
.bar-label { flex: 0 0 88px; font-size: 12.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-track { flex: 1; height: 16px; background: var(--panel-2); border-radius: 6px; overflow: hidden; min-width: 0; }
.bar-fill { height: 100%; border-radius: 6px; min-width: 2px; transition: width .3s ease; }
.bar-val { flex: 0 0 34px; text-align: right; font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.chart-empty { color: var(--muted); font-size: 13px; margin: 20px 0; text-align: center; }
</style>
