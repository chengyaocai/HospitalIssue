<script setup>
import { computed } from 'vue';

// 环形图：纯内联 SVG，circle + stroke-dasharray 绘制，中心显示合计，下方带图例。
const props = defineProps({
  items: { type: Array, default: () => [] },
  size: { type: Number, default: 180 },
  thickness: { type: Number, default: 26 },
});

const R = 70;                 // 半径（viewBox 200x200 坐标系）
const C = 2 * Math.PI * R;    // 周长

const total = computed(() => props.items.reduce((s, it) => s + (Number(it.count) || 0), 0));

const slices = computed(() => {
  let acc = 0;
  return props.items.map((it) => {
    const count = Number(it.count) || 0;
    const frac = total.value ? count / total.value : 0;
    const len = frac * C;
    const dash = `${len} ${C - len}`;
    const offset = -acc * C;
    acc += frac;
    return {
      name: it.name,
      count,
      color: it.color || '#3b82f6',
      dash,
      offset,
      percent: total.value ? Math.round((count / total.value) * 1000) / 10 : 0,
    };
  });
});
</script>

<template>
  <div class="donut">
    <div v-if="total > 0" class="donut-chart" :style="{ width: size + 'px', height: size + 'px' }">
      <svg :viewBox="`0 0 200 200`" class="donut-svg">
        <circle cx="100" cy="100" :r="R" fill="none" stroke="var(--panel-2)" :stroke-width="thickness" />
        <circle
          v-for="(s, i) in slices"
          :key="i"
          cx="100"
          cy="100"
          :r="R"
          fill="none"
          :stroke="s.color"
          :stroke-width="thickness"
          :stroke-dasharray="s.dash"
          :stroke-dashoffset="s.offset"
          transform="rotate(-90 100 100)"
        />
      </svg>
      <div class="donut-center">
        <span class="donut-total">{{ total }}</span>
        <span class="donut-cap">合计</span>
      </div>
    </div>

    <ul v-if="total > 0" class="donut-legend">
      <li v-for="(s, i) in slices" :key="i">
        <span class="dot" :style="{ background: s.color }"></span>
        <span class="lg-name">{{ s.name }}</span>
        <span class="lg-val">{{ s.count }}</span>
        <span class="lg-pct">{{ s.percent }}%</span>
      </li>
    </ul>

    <p v-else class="chart-empty">暂无数据</p>
  </div>
</template>

<style scoped>
.donut { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.donut-chart { position: relative; }
.donut-svg { width: 100%; height: 100%; display: block; }
.donut-center {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  pointer-events: none;
}
.donut-total { font-size: 26px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.donut-cap { font-size: 12px; color: var(--muted); margin-top: 2px; }
.donut-legend { list-style: none; margin: 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 8px; }
.donut-legend li { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.donut-legend .dot { width: 9px; height: 9px; border-radius: 3px; flex-shrink: 0; }
.lg-name { color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lg-val { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.lg-pct { color: var(--muted); width: 48px; text-align: right; font-variant-numeric: tabular-nums; }
.chart-empty { color: var(--muted); font-size: 13px; margin: 20px 0; text-align: center; width: 100%; }
</style>
