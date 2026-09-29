<script setup>
// 通用 sheet 页标签栏：受控组件（v-model 绑定当前激活 key）。
// 只负责渲染标签与触发切换，内容由父组件按 active === key 用 v-show 承载（切换不丢本地状态）。
const props = defineProps({
  tabs: { type: Array, default: () => [] },   // [{ key, label }]
  modelValue: { type: String, default: '' },  // 当前激活 key
});
const emit = defineEmits(['update:modelValue']);

function select(key) {
  if (key !== props.modelValue) emit('update:modelValue', key);
}
</script>

<template>
  <div class="tabs" role="tablist">
    <button
      v-for="t in tabs"
      :key="t.key"
      type="button"
      class="tab"
      :class="{ active: t.key === modelValue }"
      role="tab"
      :aria-selected="t.key === modelValue"
      @click="select(t.key)"
    >{{ t.label }}</button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  margin: 0 0 18px;
}
.tab {
  border: none;
  background: transparent;
  padding: 9px 14px;
  margin-bottom: -1px;
  font-size: 13.5px;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  border-radius: 0;
  cursor: pointer;
}
.tab:hover { background: transparent; color: var(--text); }
.tab.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 650;
}
</style>
