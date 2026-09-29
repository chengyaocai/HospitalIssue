<script setup>
// 机构切换器（v1.18；v1.18.6 移到内容区页眉右上角；v1.18.9 拆成「可切换 / 只读」两态；
// v1.18.19 随内容区页眉（.app-head）移除而迁往**顶栏**（深色宿主，两种主题下都深））。
//
// v1.18.9 的两个诉求：
//  1) **每个用户登录都要知道自己登的是哪个机构** —— 所以本组件不再只服务多机构场景，
//     单机构用户也会看到一个（只读的）机构标签；
//  2) **能不能切换由父组件按当前用户的权限判定**（能访问到第二个机构 = 有权限），
//     本组件只负责按 canSwitch 渲染对应形态，不自己判断权限。
//
// 两态刻意用**颜色**区分，让人一眼分得出「这块能点」还是「这块只是告诉你信息」：
//   可切换 → 浅色药丸（白/浅蓝底 + 深蓝字）+ 左侧主色竖条 + 下拉箭头（深色顶栏上天然醒目的交互控件）；
//   只读   → 半透明白低对比 + 无箭头，且**不是 button**（不参与 Tab 焦点、点了没反应）。
// 宿主是深色顶栏（v1.18.19 起），只读态与弹层外的容器配色按深色底调整；
// 下拉弹层仍为白底浅字（与页面其余浮层一致）。
// 切换动作交给父组件（需重签 token + 重载全部机构内数据），本组件只负责选择与展示。
import { ref, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  current: { type: Object, default: null },   // { id, code, name, active }
  orgs: { type: Array, default: () => [] },
  switching: { type: Boolean, default: false },
  // 父组件按当前用户的权限判定：true = 可切换到其它机构（渲染可点按钮 + 下拉）
  canSwitch: { type: Boolean, default: false },
});
const emit = defineEmits(['switch']);

const open = ref(false);
const root = ref(null);

function toggle() {
  if (props.switching) return;
  open.value = !open.value;
}
function isCurrent(o) {
  return !!props.current && String(props.current.id) === String(o.id);
}
function pick(o) {
  open.value = false;
  if (!o || o.id == null || isCurrent(o)) return;
  if (o.active === false) return;   // 已停用机构不可切换（后端同样会拒绝）
  emit('switch', o.id);
}
// 点击组件外部自动收起
function onDocClick(e) {
  if (root.value && !root.value.contains(e.target)) open.value = false;
}
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div class="org-switch" ref="root" :class="{ ro: !canSwitch }">
    <!-- 可切换：真交互控件（按钮 + 下拉箭头 + 弹层） -->
    <button
      v-if="canSwitch"
      class="org-btn"
      :class="{ open }"
      :disabled="switching"
      :title="current ? `当前机构：${current.name}（点击切换）` : ''"
      @click="toggle"
    >
      <span class="org-ico">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 21V6.5L12 3l8 3.5V21" />
          <path d="M4 21h16M9.5 21v-4.6h5V21" />
          <path d="M8.6 9.4h1.6M13.8 9.4h1.6M8.6 12.8h1.6M13.8 12.8h1.6" />
        </svg>
      </span>
      <span class="org-cap">当前机构</span>
      <span class="org-name">{{ switching ? '切换中…' : (current ? current.name : '未选择机构') }}</span>
      <svg class="org-caret" :class="{ up: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9.5l6 6 6-6" />
      </svg>
    </button>

    <!-- 不可切换（只有 1 个机构 / 无其它可访问机构）：只读告知，无箭头、不可点。
         刻意用 span 而非 button —— 不给键盘焦点、不出现 hover 反馈，避免「看着能点其实不能」 -->
    <span
      v-else
      class="org-ro"
      :title="current ? `当前机构：${current.name}${switching ? '（切换中…）' : ''}` : ''"
    >
      <span class="org-ico">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 21V6.5L12 3l8 3.5V21" />
          <path d="M4 21h16M9.5 21v-4.6h5V21" />
          <path d="M8.6 9.4h1.6M13.8 9.4h1.6M8.6 12.8h1.6M13.8 12.8h1.6" />
        </svg>
      </span>
      <span class="org-cap">当前机构</span>
      <span class="org-name">{{ current ? current.name : '未选择机构' }}</span>
      <span class="org-only">仅此一个</span>
    </span>

    <div v-if="canSwitch && open" class="org-pop">
      <div class="org-pop-head">切换机构</div>
      <button
        v-for="o in orgs"
        :key="o.id"
        class="org-item"
        :class="{ on: isCurrent(o), off: o.active === false }"
        :disabled="o.active === false || switching"
        @click="pick(o)"
      >
        <span class="org-item-name">{{ o.name }}</span>
        <span v-if="o.active === false" class="org-item-tag">已停用</span>
        <svg v-else-if="isCurrent(o)" class="org-item-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12.8l4.4 4.4L19 7" />
        </svg>
      </button>
      <p v-if="orgs.length === 0" class="org-empty">暂无可访问机构</p>
    </div>
  </div>
</template>

<style scoped>
/* v1.18.19 起宿主为深色顶栏（两种主题下都深）：
   可切换态 = 浅色药丸（深色底上天然醒目），只读态 = 半透明白低对比。 */
.org-switch { position: relative; }

/* ===== 两态共用的排版（只有配色/交互不同，形状保持一致，切换形态时不会跳动） ===== */
.org-ico { width: 16px; height: 16px; flex-shrink: 0; }
.org-ico svg { width: 16px; height: 16px; display: block; }
.org-cap { font-size: 12px; flex-shrink: 0; }
.org-name {
  min-width: 0; font-size: 13px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.org-caret { width: 13px; height: 13px; flex-shrink: 0; transition: transform .16s; }
.org-caret.up { transform: rotate(180deg); }

/* ===== 可切换态：浅色药丸（深色顶栏上的「这块能点」）===== */
.org-btn {
  display: inline-flex; align-items: center; gap: 8px;
  max-width: 340px;
  padding: 7px 12px; border-radius: 10px;
  background: #eef4ff;
  border: 1px solid #c3d7fb;
  /* 左侧 3px 主色竖条用 inset 阴影画，零布局位移（不用 border-left，免得文字整体右移） */
  box-shadow: inset 3px 0 0 var(--primary), var(--shadow-sm);
}
.org-btn .org-ico { color: var(--primary); opacity: 1; }
.org-btn .org-cap { color: var(--primary-d); opacity: .78; }
.org-btn .org-name { flex: 1; color: var(--primary-d); font-weight: 650; }
.org-btn .org-caret { color: var(--primary); }
.org-btn:hover { background: #e2ecfd; border-color: #a9c6f8; }
.org-btn.open { background: #dbe7fc; border-color: #93b6f5; }

/* ===== 只读态：半透明白低对比（深色顶栏上的「这只是告诉你信息」）===== */
.org-ro {
  display: inline-flex; align-items: center; gap: 8px;
  max-width: 340px;
  padding: 7px 12px; border-radius: 10px;
  background: rgba(255, 255, 255, .08);
  border: 1px solid rgba(255, 255, 255, .16);
  cursor: default;
}
.org-ro .org-ico { color: #aab6c8; opacity: .9; }
.org-ro .org-cap { color: #8fa0b8; }
.org-ro .org-name { color: #e2e8f0; font-weight: 500; }
/* 「仅此一个」小标：解释为什么这块不能点（否则用户会以为是坏了） */
.org-only {
  flex-shrink: 0;
  font-size: 10.5px; color: #cbd5e1;
  background: rgba(255, 255, 255, .1); border: 1px solid rgba(255, 255, 255, .2);
  border-radius: 999px; padding: 1px 7px;
}

/* 弹层：右对齐（宿主在右上角），避免超出视口 */
.org-pop {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 40;
  min-width: 240px; max-width: 340px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow-lg); padding: 6px;
  max-height: 46vh; overflow-y: auto;
}
.org-pop-head { font-size: 11px; color: var(--muted); padding: 5px 8px 7px; letter-spacing: .06em; }
.org-item {
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 8px 9px; border: none; background: transparent; border-radius: 8px;
  font-size: 13px; color: var(--text); text-align: left;
}
.org-item:hover { background: var(--panel-2); }
.org-item.on { background: #eef4ff; color: var(--primary-d); font-weight: 650; }
.org-item.off { color: var(--muted); cursor: not-allowed; }
.org-item.off:hover { background: transparent; }
.org-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.org-item-tag { font-size: 10.5px; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; flex-shrink: 0; }
.org-item-tick { width: 15px; height: 15px; flex-shrink: 0; color: var(--primary); }
.org-empty { font-size: 12.5px; color: var(--muted); padding: 10px 9px; margin: 0; }
</style>
