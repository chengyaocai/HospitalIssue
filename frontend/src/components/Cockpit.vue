<script setup>
import { computed } from 'vue';
import DonutChart from './DonutChart.vue';
import BarList from './BarList.vue';

// 数据驾驶舱：纯 CSS + 内联 SVG，无任何图表库。容忍 data 为 null（加载失败时不报错）。
const props = defineProps({
  data: { type: Object, default: null },
});

const STATUS_COLORS = { 待处理: '#94a3b8', 处理中: '#3b82f6', 已解决: '#10b981', 已关闭: '#64748b' };
// 严重程度由浅到深（低<中<高<紧急）
const SEVERITY_COLORS = ['#bfdbfe', '#60a5fa', '#3b82f6', '#1d4ed8'];
const SATISFACTION_COLORS = { 满意: '#10b981', 一般: '#f59e0b', 不满意: '#ef4444' };

const d = computed(() => props.data || {});
const kpi = computed(() => d.value.kpi || {});
const byMonth = computed(() => d.value.byMonth || []);
const byRecentDays = computed(() => d.value.byRecentDays || []);

const statusItems = computed(() =>
  (d.value.byStatus || []).map((s) => ({ name: s.status, count: s.count, color: STATUS_COLORS[s.status] || '#94a3b8' }))
);
const satisfactionItems = computed(() =>
  (d.value.bySatisfaction || []).map((s) => ({ name: s.name, count: s.count, color: SATISFACTION_COLORS[s.name] || '#94a3b8' }))
);
const typeItems = computed(() => (d.value.byType || []).map((t) => ({ label: t.type, count: t.count })));
const severityItems = computed(() => (d.value.bySeverity || []).map((s) => ({ label: s.severity, count: s.count })));
const deptItems = computed(() => (d.value.byDepartment || []).map((x) => ({ label: x.department, count: x.count })));
const sysItems = computed(() => (d.value.bySoftwareSystem || []).map((x) => ({ label: x.softwareSystem, count: x.count })));
const handlerItems = computed(() => (d.value.byHandler || []).map((x) => ({ label: x.handler, count: x.count })));

// KPI：分「核心指标」与「运营指标」两组，各用 auto-fit 网格自动铺满、不出现半空行。
const coreKpis = computed(() => {
  const k = kpi.value;
  return [
    { key: 'total', label: '问题总数', value: fmt(k.total), tone: 'blue' },
    { key: 'pending', label: '待处理（含处理中）', value: fmt(k.pending), tone: 'slate' },
    { key: 'resolved', label: '已解决', value: fmt(k.resolved), tone: 'green' },
    { key: 'rate', label: '解决率', value: pctText(k.resolvedRate), tone: 'green' },
  ];
});
const opsKpis = computed(() => {
  const k = kpi.value;
  const delta = Number(k.monthDelta) || 0;
  return [
    { key: 'closed', label: '已关闭', value: fmt(k.closed), tone: 'slate' },
    // v1.18.28: 平均处理时长按工作日 8 小时折算（工作日 8:00–12:00、13:00–17:00，节假日暂不计），悬停 label 查看口径
    { key: 'hours', label: '平均处理时长', title: '按工作日 8 小时折算（工作日 8:00–12:00、13:00–17:00，节假日暂不计）', value: k.avgResolveHours ? `${k.avgResolveHours} h` : '—', tone: 'violet' },
    { key: 'sat', label: '满意率', value: k.ratedCount ? pctText(k.satisfactionRate) : '—', tone: 'amber', sub: `已回访 ${fmt(k.ratedCount)}` },
    { key: 'month', label: '本月新增', value: fmt(k.monthCount), tone: 'blue', delta, sub: `上月 ${fmt(k.lastMonthCount)}` },
    { key: 'dept', label: '涉及科室', value: fmt(k.departmentCount), tone: 'slate' },
    { key: 'handler', label: '处理人数', value: fmt(k.handlerCount), tone: 'slate' },
    { key: 'sys', label: '软件系统', value: fmt(k.softwareSystemCount), tone: 'slate' },
  ];
});

function fmt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('zh-CN') : '0';
}
function pctText(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${v}%` : '0%';
}
function deltaText(delta) {
  if (delta > 0) return `↑ ${delta}`;
  if (delta < 0) return `↓ ${Math.abs(delta)}`;
  return '持平';
}

// 近 12 个月趋势（竖向柱状）
const monthMax = computed(() => Math.max(1, ...byMonth.value.map((m) => Number(m.count) || 0)));
function monHeight(v) { return Math.round(((Number(v) || 0) / monthMax.value) * 100); }
function shortMonth(m) { return m ? String(m).slice(5) : ''; }

// 近 14 天登记量（迷你柱状）
const dayMax = computed(() => Math.max(1, ...byRecentDays.value.map((x) => Number(x.count) || 0)));
function dayHeight(v) { return Math.round(((Number(v) || 0) / dayMax.value) * 100); }
function shortDay(x) { return x ? String(x).slice(8) : ''; }

const isEmptyAll = computed(() => !(Number(kpi.value.total) > 0));
</script>

<template>
  <section class="cockpit">
    <!-- ① KPI：核心指标 + 运营指标 -->
    <div class="panel kpi-panel">
      <div class="kpi-group">
        <div class="kpi-group-title">核心指标</div>
        <div class="kpi-grid core">
          <div v-for="c in coreKpis" :key="c.key" class="kpi" :class="'tone-' + c.tone">
            <span class="kpi-label">{{ c.label }}</span>
            <span class="kpi-value">{{ c.value }}</span>
            <span v-if="c.sub" class="kpi-sub">{{ c.sub }}</span>
          </div>
        </div>
      </div>

      <div class="kpi-group">
        <div class="kpi-group-title">运营指标</div>
        <div class="kpi-grid ops">
          <div v-for="c in opsKpis" :key="c.key" class="kpi" :class="'tone-' + c.tone">
            <!-- v1.18.28: label 支持 title 悬停口径说明（仅平均处理时长卡配置） -->
            <span class="kpi-label" :title="c.title || null">{{ c.label }}</span>
            <span class="kpi-value">
              {{ c.value }}
              <span v-if="c.key === 'month'" class="delta" :class="{ up: c.delta > 0, down: c.delta < 0 }">{{ deltaText(c.delta) }}</span>
            </span>
            <span v-if="c.sub" class="kpi-sub">{{ c.sub }}</span>
          </div>
        </div>
      </div>

      <div v-if="isEmptyAll" class="c-empty">
        <span class="c-empty-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" />
            <path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
          </svg>
        </span>
        <span>暂无任何问题数据</span>
      </div>
    </div>

    <!-- ② 图表网格：≥1440 四列 / ≥1200 三列 / ≥880 两列 / 否则单列，dense 自动补位保证每行排满 -->
    <div class="grid">
      <!-- A 状态分布 -->
      <div class="panel">
        <div class="panel-head"><h4>状态分布</h4><span class="panel-sub">各处理状态占比</span></div>
        <div class="panel-body">
          <DonutChart v-if="statusItems.length" :items="statusItems" />
          <div v-else class="c-empty">
            <span class="c-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" /><path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg></span>
            <span>暂无数据</span>
          </div>
        </div>
      </div>

      <!-- B 问题类型分布 -->
      <div class="panel">
        <div class="panel-head"><h4>问题类型分布</h4><span class="panel-sub">故障 / 需求 / 咨询 / 其他</span></div>
        <div class="panel-body">
          <BarList v-if="typeItems.length" :items="typeItems" color="#7c3aed" />
          <div v-else class="c-empty">
            <span class="c-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" /><path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg></span>
            <span>暂无数据</span>
          </div>
        </div>
      </div>

      <!-- C 近 12 个月趋势（宽卡） -->
      <div class="panel span-2">
        <div class="panel-head"><h4>近 12 个月趋势</h4><span class="panel-sub">逐月登记量</span></div>
        <div class="panel-body">
          <div v-if="byMonth.length" class="bars-v">
            <div v-for="m in byMonth" :key="m.month" class="vbar-col">
              <span class="vbar-val">{{ m.count }}</span>
              <div class="vbar-track"><div class="vbar-fill" :style="{ height: monHeight(m.count) + '%' }"></div></div>
              <span class="vbar-label">{{ shortMonth(m.month) }}</span>
            </div>
          </div>
          <div v-else class="c-empty">
            <span class="c-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" /><path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg></span>
            <span>暂无数据</span>
          </div>
        </div>
      </div>

      <!-- D 严重程度分布 -->
      <div class="panel">
        <div class="panel-head"><h4>严重程度分布</h4><span class="panel-sub">低 → 紧急</span></div>
        <div class="panel-body">
          <BarList v-if="severityItems.length" :items="severityItems" :color-by-index="SEVERITY_COLORS" />
          <div v-else class="c-empty">
            <span class="c-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" /><path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg></span>
            <span>暂无数据</span>
          </div>
        </div>
      </div>

      <!-- E 软件系统分布 -->
      <div class="panel">
        <div class="panel-head"><h4>软件系统分布</h4><span class="panel-sub">按系统统计</span></div>
        <div class="panel-body">
          <BarList v-if="sysItems.length" :items="sysItems" :max="8" color="#0891b2" />
          <div v-else class="c-empty">
            <span class="c-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" /><path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg></span>
            <span>暂无数据</span>
          </div>
        </div>
      </div>

      <!-- F 按科室分布（宽卡） -->
      <div class="panel span-2">
        <div class="panel-head"><h4>按科室分布</h4><span class="panel-sub">数量降序 · TOP 8</span></div>
        <div class="panel-body">
          <BarList v-if="deptItems.length" :items="deptItems" :max="9" color="#2563eb" />
          <div v-else class="c-empty">
            <span class="c-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" /><path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg></span>
            <span>暂无数据</span>
          </div>
        </div>
      </div>

      <!-- G 处理人工作量 TOP -->
      <div class="panel">
        <div class="panel-head"><h4>处理人工作量</h4><span class="panel-sub">TOP 10</span></div>
        <div class="panel-body">
          <BarList v-if="handlerItems.length" :items="handlerItems" :max="8" color="#059669" />
          <div v-else class="c-empty">
            <span class="c-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" /><path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg></span>
            <span>暂无数据</span>
          </div>
        </div>
      </div>

      <!-- H 满意度分布 -->
      <div class="panel">
        <div class="panel-head"><h4>满意度分布</h4><span class="panel-sub">仅统计已回访</span></div>
        <div class="panel-body">
          <DonutChart v-if="satisfactionItems.length" :items="satisfactionItems" />
          <div v-else class="c-empty">
            <span class="c-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" /><path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg></span>
            <span>暂无数据</span>
          </div>
        </div>
      </div>

      <!-- I 近 14 天登记量（宽卡） -->
      <div class="panel span-2">
        <div class="panel-head"><h4>近 14 天登记量</h4><span class="panel-sub">每日新增</span></div>
        <div class="panel-body">
          <div v-if="byRecentDays.length" class="bars-v short">
            <div v-for="x in byRecentDays" :key="x.date" class="vbar-col">
              <span class="vbar-val">{{ x.count }}</span>
              <div class="vbar-track"><div class="vbar-fill mini" :style="{ height: dayHeight(x.count) + '%' }"></div></div>
              <span class="vbar-label">{{ shortDay(x.date) }}</span>
            </div>
          </div>
          <div v-else class="c-empty">
            <span class="c-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7" /><path d="M4 13.5h4l1.5 2.5h5l1.5-2.5h4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg></span>
            <span>暂无数据</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cockpit { display: flex; flex-direction: column; gap: 16px; }

.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  padding: 16px 18px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 14px; }
.panel-head h4 {
  margin: 0; font-size: 14px;
  display: flex; align-items: center; gap: 8px;
}
.panel-head h4::before {
  content: ''; width: 3px; height: 14px; border-radius: 2px;
  background: var(--primary); flex-shrink: 0;
}
.panel-sub { font-size: 12px; color: var(--muted); text-align: right; }
/* 图表内容：撑满剩余高度并垂直居中，配合网格使同行卡片等高 */
.panel-body { flex: 1; display: flex; flex-direction: column; justify-content: center; min-height: 0; }

/* KPI */
.kpi-panel { gap: 14px; }
.kpi-group { display: flex; flex-direction: column; gap: 8px; }
.kpi-group-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 650; color: #48566b; letter-spacing: .04em;
}
.kpi-group-title::before { content: ''; width: 3px; height: 12px; border-radius: 2px; background: var(--primary); }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.kpi {
  border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px;
  background: var(--panel-2); display: flex; flex-direction: column; gap: 4px; min-width: 0;
}
.kpi-label { font-size: 12px; color: var(--muted); }
.kpi-value {
  font-size: 20px; font-weight: 700; color: var(--text);
  font-variant-numeric: tabular-nums; letter-spacing: -.01em;
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
.kpi-grid.core .kpi-value { font-size: 26px; }
.kpi-sub { font-size: 11.5px; color: var(--muted); }
.kpi.tone-blue { border-top: 3px solid #2563eb; }
.kpi.tone-green { border-top: 3px solid #10b981; }
.kpi.tone-slate { border-top: 3px solid #94a3b8; }
.kpi.tone-violet { border-top: 3px solid #7c3aed; }
.kpi.tone-amber { border-top: 3px solid #f59e0b; }
.delta {
  font-size: 12px; font-weight: 600; padding: 1px 7px; border-radius: 999px;
  background: #eef2f7; color: #475569;   /* 中性色，不使用股票红绿 */
}
.delta.up { color: #334155; }
.delta.down { color: #64748b; }

/* 图表网格：≥1440 四列 / ≥1200 三列 / ≥880 两列 / 否则单列；dense 自动补位避免半空行 */
.grid { display: grid; grid-template-columns: 1fr; gap: 16px; grid-auto-flow: dense; }
@media (min-width: 880px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 1200px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (min-width: 1440px) { .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.span-2 { grid-column: 1 / -1; }
@media (min-width: 880px) { .span-2 { grid-column: span 2; } }

/* 竖向柱状 */
.bars-v { display: flex; align-items: flex-end; gap: 6px; height: 168px; padding-top: 6px; }
.bars-v.short { height: 120px; }
.vbar-col { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 5px; }
.vbar-val { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.vbar-track { width: 100%; flex: 1; display: flex; align-items: flex-end; background: var(--panel-2); border-radius: 6px; }
.vbar-fill { width: 100%; border-radius: 6px 6px 0 0; background: linear-gradient(180deg, #4f8bfb, #2563eb); min-height: 2px; transition: height .3s ease; }
.vbar-fill.mini { background: linear-gradient(180deg, #34d399, #059669); }
.vbar-label { font-size: 10.5px; color: var(--muted); white-space: nowrap; }

/* 统一空态：居中的图标 + 文案（与列表页 .empty 观感一致） */
.c-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--muted); font-size: 13px; padding: 24px 12px; text-align: center;
}
.c-empty-ico {
  width: 44px; height: 44px; border-radius: 50%;
  background: #f2f6fc; color: #9bb0cb;
  display: flex; align-items: center; justify-content: center;
}
.c-empty-ico svg { width: 22px; height: 22px; }
</style>
