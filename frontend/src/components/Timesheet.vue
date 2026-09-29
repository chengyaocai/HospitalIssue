<script setup>
// 实施协同 · 工时登记（v1.18.40）：移植自 WXP底稿+PMIS 系统的工时填报页（Views/AISkill/Timesheet.cshtml）。
// 本系统只做界面与转发：所有业务（PMIS 工时查询/提交、WXP 底稿拉取、医院绑定、知识库）
// 由后端 routes/timesheet.js 代理到 WXP 系统（AISkillController），认证全部在上游承担。
// 交互与 WXP 原版一致：单日模式（查未填日期 → 拉底稿生成工作内容 → 预览 → 提交）
// + 全部医院批量模式（8 小时按当天关闭底稿占比均分）+ 工时工作知识库。
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

// —— 配置与字典 ——
const cfg = ref(null);
const cfgError = ref('');
const hospitals = ref([]);
const hospLoading = ref(false);
const hospError = ref('');

// —— 单日模式状态 ——
const mode = ref('normal'); // normal | all
const selHospitalId = ref('');
const unfilledDates = ref([]);
const unfilledTotal = ref(0);
const querying = ref(false);
const rangeStart = ref('');
const rangeEnd = ref('');
const selectedDate = ref('');
const form = ref({ workDate: '', type: 2, cost: 2, process: 62, hours: 8, inProjectId: '', inProjectName: '' });
const includeInprog = ref(false);
const draftsLoading = ref(false);
const draft = ref(null); // { hospitalName, mineCount, closedTodayCount, inProgressCount, workContent, drafts }
const workContent = ref('');
const statusMsg = ref({ kind: 'idle', text: '等待操作...', detail: '' });
const currentEntries = ref(null);
const projects = ref([]); // 在建项目候选（选中医院后可拉取）
const projLoading = ref(false);

// —— 批量（全部医院）模式 ——
const allLoading = ref(false);
const allDate = ref('');
const allType = ref(2);
const allCost = ref(2);
const allProcess = ref(62);
const allTotal = ref(8);
const allIncludeInprog = ref(false);
const allRows = ref([]); // { hospitalId, hospitalName, closedTodayCount, inProgressCount, workContent, topDrafts, inProjectId, inProjectName, hours, expanded }
const allWarning = ref('');
const allStatus = ref({ kind: 'idle', text: '' });
const allTarget = computed(() => Number(allTotal.value) || 0);
const allSum = computed(() => Math.round(allRows.value.reduce((s, r) => s + (Number(r.hours) || 0), 0) * 100) / 100);
const allDiffKind = computed(() => {
  const d = Math.round((allSum.value - allTarget.value) * 100) / 100;
  if (Math.abs(d) < 0.01) return 'ok';
  return d < 0 ? 'short' : 'warn';
});
const submittableRows = computed(() => allRows.value.filter((r) => Number(r.hours) > 0 && (r.workContent || '').trim()));

// —— 知识库 ——
const kbOpen = ref(false);
const kbItems = ref([]);
const kbTotal = ref(0);
const kbInput = ref('');
const kbBusy = ref(false);

// —— toast（自包含，参照 Chat.vue 简易实现）——
const toast = ref({ show: false, text: '', kind: 'info' });
let toastTimer = null;
function showToast(text, kind = 'info') {
  toast.value = { show: true, text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 3200);
}

const selHospital = computed(() => hospitals.value.find((h) => h.hospitalId === selHospitalId.value) || null);

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function quickRange(kind) {
  const now = new Date();
  const end = fmtDate(now);
  if (kind === 'today') { rangeStart.value = end; }
  else if (kind === 'week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    rangeStart.value = fmtDate(mon);
  } else if (kind === 'month') {
    rangeStart.value = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1));
  }
  rangeEnd.value = end;
}

async function loadConfig() {
  cfgError.value = '';
  try {
    const d = await api.tsConfig();
    cfg.value = d;
    form.value.type = d.defaultTimesheetType ?? 2;
    form.value.cost = d.defaultCostLineId ?? 2;
    form.value.process = d.defaultProcessType ?? 62;
    form.value.hours = d.defaultWorkHours ?? 8;
    allType.value = d.defaultTimesheetType ?? 2;
    allCost.value = d.defaultCostLineId ?? 2;
    allProcess.value = d.defaultProcessType ?? 62;
    allTotal.value = d.defaultWorkHours ?? 8;
  } catch (e) {
    cfgError.value = e.message || '加载配置失败';
  }
}

async function loadHospitals() {
  hospLoading.value = true;
  hospError.value = '';
  try {
    const d = await api.tsHospitals();
    if (!d.success) { hospError.value = d.message || '医院列表获取失败'; return; }
    hospitals.value = d.hospitals || [];
  } catch (e) {
    hospError.value = e.message || '医院列表获取失败';
  } finally {
    hospLoading.value = false;
  }
}

function onHospitalChange() {
  form.value.inProjectId = selHospital.value?.inProjectId || '';
  form.value.inProjectName = selHospital.value?.inProjectName || '';
  projects.value = [];
}

async function ensureProjects() {
  if (!selHospital.value) return;
  projLoading.value = true;
  try {
    const d = await api.tsProjects({ hospitalCode: selHospital.value.hospitalCode, hospitalName: selHospital.value.hospitalName });
    if (d.success) projects.value = d.projects || [];
  } catch { /* 候选拉取失败不阻断，配置默认值仍可用 */ }
  finally { projLoading.value = false; }
}

function onProjectChange() {
  const opt = projects.value.find((p) => String(p.inProjectId) === String(form.value.inProjectId));
  form.value.inProjectName = opt ? opt.inProjectName : (form.value.inProjectName || '');
}

async function saveSingleProject() {
  if (!selHospital.value) { showToast('请先选择医院', 'warn'); return; }
  try {
    const d = await api.tsSaveProject({
      hospitalCode: selHospital.value.hospitalId,
      hospitalName: selHospital.value.hospitalName,
      inProjectId: Number(form.value.inProjectId) || 0,
      inProjectName: form.value.inProjectName || '',
    });
    showToast(d.success ? '已记住（写回 WXP 配置，下次默认使用）' : ('保存失败：' + (d.message || '')), d.success ? 'success' : 'danger');
  } catch (e) { showToast('保存失败：' + e.message, 'danger'); }
}

async function queryUnfilled() {
  if (!rangeStart.value && !rangeEnd.value) { showToast('请先选择日期范围（可用今日/本周/本月快捷）', 'warn'); return; }
  querying.value = true;
  try {
    const d = await api.tsUnfilled({ startDate: rangeStart.value || undefined, endDate: rangeEnd.value || undefined });
    if (!d.success) { showToast(d.message || '查询失败', 'danger'); return; }
    unfilledDates.value = d.dates || [];
    unfilledTotal.value = d.totalDays || 0;
  } catch (e) {
    showToast('查询失败：' + e.message, 'danger');
  } finally {
    querying.value = false;
  }
}

async function selectDate(dateStr) {
  selectedDate.value = dateStr;
  form.value.workDate = dateStr;
  await loadDrafts(dateStr);
}

async function loadDrafts(dateStr) {
  if (!selHospital.value) { showToast('请先选择医院', 'warn'); return; }
  if (!dateStr) { showToast('请先选择填报日期', 'warn'); return; }
  draftsLoading.value = true;
  try {
    const d = await api.tsDrafts({
      hospitalId: selHospital.value.hospitalId,
      hospitalName: selHospital.value.hospitalName,
      workDate: dateStr,
      includeInProgress: includeInprog.value,
    });
    if (!d.success) { showToast(d.message || '底稿获取失败', 'danger'); return; }
    draft.value = d;
    workContent.value = d.workContent || '';
    ensureProjects();
  } catch (e) {
    showToast('底稿获取失败：' + e.message, 'danger');
  } finally {
    draftsLoading.value = false;
  }
}

function addAiTag() {
  if (!workContent.value.startsWith('【AI工时】')) workContent.value = '【AI工时】\n' + workContent.value;
}

function buildEntry() {
  if (!selHospital.value) { showToast('请先选择医院', 'warn'); return null; }
  const workDate = form.value.workDate;
  const workHours = Math.round((Number(form.value.hours) || 0) * 100) / 100;
  const content = workContent.value.trim();
  const timesheetType = Number(form.value.type);
  const costLineId = Number(form.value.cost);
  const processType = Number(form.value.process);
  if (!workDate) { showToast('请选择填报日期', 'warn'); return null; }
  if (!content) { showToast('工作内容不能为空', 'warn'); return null; }
  if (workHours <= 0 || workHours > 8) { showToast('工时必须在 0.5 ~ 8 小时之间', 'warn'); return null; }
  // PMIS-MCP API 111 官方字段规范（与 WXP 原版 buildEntries 一致）
  const entry = { timesheet_type: timesheetType, work_date: workDate, work_hours: workHours, work_content: content, cost_line_id: costLineId };
  if (timesheetType === 2) {
    const inProj = Number(form.value.inProjectId);
    if (!inProj) { showToast('「实施-无计划」工时必须选择在建项目', 'warn'); return null; }
    entry.in_project_id = inProj;
    entry.process_type = processType;
  } else if (timesheetType === 1) { showToast('服务工时需要客户 ID，暂不支持本页面填报（请用 PMIS PC 端）', 'warn'); return null; }
  else if (timesheetType === 6) { showToast('专项工时需要专项标签，暂不支持本页面填报', 'warn'); return null; }
  else if (timesheetType === 99) { showToast('管理工时需要管理标签，暂不支持本页面填报', 'warn'); return null; }
  return entry;
}

function previewSubmit() {
  const entry = buildEntry();
  if (!entry) return;
  currentEntries.value = entry;
  statusMsg.value = { kind: 'info', text: '已生成提交预览，请确认后提交', detail: JSON.stringify(entry, null, 2) };
}

async function doSubmit() {
  let entry = currentEntries.value;
  if (!entry) { entry = buildEntry(); if (!entry) return; }
  statusMsg.value = { kind: 'info', text: '⏳ 提交中...', detail: '' };
  try {
    const result = await api.tsSubmit({ entries: [entry] });
    if (result.success === true) {
      statusMsg.value = { kind: 'success', text: result.message || `✅ ${form.value.workDate} 提交成功`, detail: result.detail || '' };
      showToast('✅ 工时提交成功', 'success');
      currentEntries.value = null;
      queryUnfilled();
    } else {
      statusMsg.value = { kind: 'danger', text: result.message || '❌ 提交失败（无返回信息）', detail: result.detail || '' };
      showToast('❌ 工时提交失败', 'danger');
    }
  } catch (e) {
    statusMsg.value = { kind: 'danger', text: '❌ 请求失败：' + e.message, detail: '' };
  }
}

// —— 批量（全部医院）模式 ——
function enterAllMode() {
  mode.value = 'all';
  if (!allDate.value) allDate.value = fmtDate(new Date());
  loadAllDrafts();
}
function exitAllMode() { mode.value = 'normal'; }

async function loadAllDrafts() {
  if (!allDate.value) { showToast('请先选择填报日期', 'warn'); return; }
  allLoading.value = true;
  allWarning.value = '';
  allStatus.value = { kind: 'idle', text: '' };
  try {
    const d = await api.tsBatchDrafts({ workDate: allDate.value, totalHours: allTotal.value, includeInProgress: allIncludeInprog.value });
    if (!d.success) { showToast(d.message || '批量分析失败', 'danger'); return; }
    allWarning.value = d.warning || '';
    allRows.value = (d.rows || []).map((r) => ({
      hospitalId: r.hospitalId,
      hospitalName: r.hospitalName,
      mineCount: r.mineCount,
      closedTodayCount: r.closedTodayCount,
      inProgressCount: r.inProgressCount,
      workContent: r.workContent,
      topDrafts: r.topDrafts || [],
      inProjectId: r.inProjectId || '',
      inProjectName: r.inProjectName || '',
      ratio: r.ratio,
      hours: r.suggestedHours ?? 0,
      expanded: true,
    }));
    if (!allRows.value.length) showToast('当天各医院都没有本人关闭的底稿', 'info');
  } catch (e) {
    showToast('批量分析失败：' + e.message, 'danger');
  } finally {
    allLoading.value = false;
  }
}

// 重新均分：把总工时按当天关闭数占比重算（0.5h 粒度，余数补给关闭数最多的医院；与 WXP 原版同口径）
function redistributeAll() {
  const rows = allRows.value;
  if (!rows.length) return;
  const totalClosed = rows.reduce((s, r) => s + (r.closedTodayCount || 0), 0);
  let remaining = allTarget.value;
  for (const r of rows) {
    const ratio = totalClosed > 0 ? r.closedTodayCount / totalClosed : 1 / rows.length;
    let h = Math.round(allTarget.value * ratio * 2) / 2;
    if (h < 0.5) h = 0.5;
    if (h > remaining) h = remaining;
    remaining = Math.round((remaining - h) * 100) / 100;
    r.hours = h;
  }
  if (remaining >= 0.5) {
    const top = rows.reduce((a, b) => ((a.closedTodayCount || 0) >= (b.closedTodayCount || 0) ? a : b));
    top.hours = Math.round(((top.hours || 0) + remaining) * 100) / 100;
  }
}

async function saveRowProject(row) {
  try {
    const d = await api.tsSaveProject({
      hospitalCode: row.hospitalId,
      hospitalName: row.hospitalName,
      inProjectId: Number(row.inProjectId) || 0,
      inProjectName: row.inProjectName || '',
    });
    showToast(d.success ? `已记住 ${row.hospitalName} 的项目选择` : ('保存失败：' + (d.message || '')), d.success ? 'success' : 'danger');
  } catch (e) { showToast('保存失败：' + e.message, 'danger'); }
}

async function submitAll() {
  const tt = Number(allType.value);
  const rows = submittableRows.value;
  if (!rows.length) { showToast('没有可提交的行（工时 > 0 且工作内容不为空）', 'warn'); return; }
  const noProj = rows.find((r) => tt === 2 && !r.inProjectId);
  if (noProj) { showToast(`${noProj.hospitalName} 是「实施-无计划」工时，必须配置在建项目`, 'warn'); return; }
  const entries = rows.map((r) => ({
    hospitalId: r.hospitalId,
    hospitalName: r.hospitalName,
    workDate: allDate.value,
    hours: Number(r.hours),
    timesheetType: tt,
    costLineId: Number(allCost.value),
    processType: Number(allProcess.value),
    inProjectId: Number(r.inProjectId) || 0,
    workContent: (r.workContent || '').trim(),
  }));
  allStatus.value = { kind: 'info', text: `⏳ 正在批量提交 ${rows.length} 家医院...` };
  try {
    const data = await api.tsBatchSubmit(entries);
    if (Array.isArray(data.results)) {
      for (const res of data.results) {
        const row = allRows.value.find((r) => r.hospitalId === res.hospitalId);
        if (row) row._submitMsg = res.ok ? `✅ PMIS 导入成功（${res.hours}h）` : `❌ PMIS 导入失败：${res.message || ''}`;
      }
    }
    allStatus.value = { kind: data.success ? 'success' : 'danger', text: data.message || (data.success ? '批量提交完成 ✅' : '批量提交部分失败 ⚠️') };
    showToast(data.message || (data.success ? '批量提交完成 ✅' : '批量提交部分失败 ⚠️'), data.success ? 'success' : 'warn');
  } catch (e) {
    allStatus.value = { kind: 'danger', text: '批量提交失败：' + e.message };
  }
}

// —— 知识库 ——
async function openKb() {
  kbOpen.value = true;
  await kbLoad();
}
async function kbLoad() {
  kbBusy.value = true;
  try {
    const d = await api.tsKb();
    kbTotal.value = d.total || 0;
    kbItems.value = d.items || [];
  } catch (e) { showToast('知识库加载失败：' + e.message, 'danger'); }
  finally { kbBusy.value = false; }
}
async function kbAdd() {
  const v = kbInput.value.trim();
  if (!v) { showToast('请输入内容', 'warn'); return; }
  try {
    const d = await api.tsKbAdd({ content: v });
    if (d.success) { kbInput.value = ''; kbLoad(); showToast('已添加', 'success'); }
    else showToast('添加失败：' + (d.message || ''), 'danger');
  } catch (e) { showToast('添加失败：' + e.message, 'danger'); }
}
async function kbDelete(idx) {
  try {
    const d = await api.tsKbDelete({ index: idx });
    if (d.success) { kbLoad(); showToast('已删除', 'success'); }
    else showToast('删除失败：' + (d.message || ''), 'danger');
  } catch (e) { showToast('删除失败：' + e.message, 'danger'); }
}

onMounted(async () => {
  await Promise.all([loadConfig(), loadHospitals()]);
});
</script>

<template>
  <div class="ts">
    <!-- 单日模式 / 批量模式切换提示条 -->
    <div v-if="mode === 'all'" class="ts-banner">
      <b>全部医院批量填报</b>
      <span class="muted">（{{ hospitals.length }} 家医院，按当天关闭底稿占比均分 {{ allTarget }} 小时）</span>
      <button class="btn ghost" style="margin-left:auto" @click="exitAllMode">退出全部模式</button>
    </div>

    <div class="ts-main">
      <!-- 左栏 -->
      <aside class="ts-left">
        <div class="card">
          <div class="card-title">医院</div>
          <select v-model="selHospitalId" class="ipt" @change="onHospitalChange">
            <option value="" disabled>{{ hospLoading ? '加载中...' : '请选择医院' }}</option>
            <option v-for="h in hospitals" :key="h.hospitalId" :value="h.hospitalId">
              {{ h.hospitalName }}{{ h.hasConfig ? ' ✓' : '' }}
            </option>
          </select>
          <div v-if="hospError" class="err">{{ hospError }}</div>
          <div v-if="selHospital" class="muted small" style="margin-top:6px">
            {{ selHospital.hospitalName }}<template v-if="selHospital.inProjectId"> · 项目 {{ selHospital.inProjectId }} {{ selHospital.inProjectName }}</template>
          </div>
          <button class="btn primary block" style="margin-top:8px" @click="enterAllMode">全部医院批量填报（8 小时均分）</button>
        </div>

        <div class="card">
          <div class="card-title">未填报日期查询</div>
          <div class="row2">
            <input v-model="rangeStart" type="date" class="ipt">
            <span class="muted">~</span>
            <input v-model="rangeEnd" type="date" class="ipt">
          </div>
          <div class="row2" style="margin-top:6px">
            <button class="btn ghost" @click="quickRange('today')">今日</button>
            <button class="btn ghost" @click="quickRange('week')">本周</button>
            <button class="btn ghost" @click="quickRange('month')">本月</button>
          </div>
          <button class="btn primary block" style="margin-top:8px" :disabled="querying" @click="queryUnfilled">
            {{ querying ? '查询中...' : '查询未填报' }}
          </button>
        </div>

        <div class="card grow">
          <div class="card-title">未填报日期 <span class="muted small">{{ unfilledTotal }} 天</span></div>
          <div class="date-list">
            <div v-if="!unfilledDates.length" class="empty">点击上方查询</div>
            <button
              v-for="d in unfilledDates" :key="d"
              class="date-chip" :class="{ active: d === selectedDate }"
              @click="selectDate(d)"
            >{{ d }}</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">工时工作知识库 <button class="btn ghost" style="margin-left:auto" @click="openKb">管理</button></div>
          <div class="muted small">共 {{ kbTotal }} 条常用工作内容</div>
        </div>
      </aside>

      <!-- 右栏 -->
      <section class="ts-right">
        <!-- 空状态 -->
        <div v-if="!selHospitalId && mode === 'normal'" class="ts-empty">
          <div class="ts-empty-icon">🕘</div>
          <b>请先在左侧选择医院</b>
          <span class="muted small">工时数据由 PMIS 提供，需确保 WXP 底稿系统在线</span>
        </div>

        <!-- 单日模式 -->
        <template v-else-if="mode === 'normal'">
          <div class="card">
            <div class="card-title">工时填报表单</div>
            <div class="grid3">
              <label class="fld"><span class="lbl"><i class="req">*</i> 填报日期 <small class="muted">(改后点「AI 自动生成」重取当天底稿)</small></span>
                <input v-model="form.workDate" type="date" class="ipt">
              </label>
              <label class="fld"><span class="lbl"><i class="req">*</i> 工时类型</span>
                <select v-model="form.type" class="ipt">
                  <option v-for="t in cfg?.timesheetTypes || []" :key="t.value" :value="t.value">{{ t.label }}</option>
                </select>
              </label>
              <label class="fld"><span class="lbl"><i class="req">*</i> 费用归属条线</span>
                <select v-model="form.cost" class="ipt">
                  <option v-for="t in cfg?.costLineOptions || []" :key="t.value" :value="t.value">{{ t.label }}</option>
                </select>
              </label>
            </div>
            <div class="grid3" style="margin-top:8px">
              <label class="fld"><span class="lbl"><i class="req">*</i> 工序类型</span>
                <select v-model="form.process" class="ipt">
                  <option v-for="t in cfg?.processTypeOptions || []" :key="t.value" :value="t.value">{{ t.label }}</option>
                </select>
              </label>
              <label class="fld"><span class="lbl"><i class="req">*</i> 工时(小时)</span>
                <input v-model.number="form.hours" type="number" min="0" max="8" step="0.5" class="ipt">
              </label>
              <label class="fld"><span class="lbl">当前医院</span>
                <input type="text" class="ipt" :value="selHospital?.hospitalName || ''" readonly>
              </label>
            </div>
            <div class="grid2" style="margin-top:8px">
              <label class="fld"><span class="lbl">在建项目 <small class="muted">（来自 PMIS，默认取配置）</small>
                <button class="linkbtn" type="button" @click="saveSingleProject">💾 记住</button></span>
                <select v-model="form.inProjectId" class="ipt" @focus="ensureProjects" @change="onProjectChange">
                  <option value="">（不选 / 未配置）</option>
                  <option v-for="p in projects" :key="p.inProjectId" :value="p.inProjectId">
                    {{ p.isConfigured ? '✓ ' : '' }}{{ p.inProjectId }} — {{ p.inProjectName }}{{ p.executeStatus ? '［' + p.executeStatus + '］' : '' }}
                  </option>
                  <option v-if="form.inProjectId && !projects.some((p) => String(p.inProjectId) === String(form.inProjectId))" :value="form.inProjectId">
                    ✓ {{ form.inProjectId }} — {{ form.inProjectName || '当前配置值（PMIS 未返回）' }}
                  </option>
                </select>
              </label>
              <label class="fld"><span class="lbl">在建项目名称</span>
                <input type="text" class="ipt" :value="form.inProjectName" readonly placeholder="从配置读取">
              </label>
            </div>
          </div>

          <div class="card grow">
            <div class="card-title">底稿统计 &amp; 工作内容
              <span v-if="draftsLoading" class="muted small">加载底稿中...</span>
              <button class="btn ghost" style="margin-left:auto" :disabled="draftsLoading || !form.workDate" @click="loadDrafts(form.workDate)">✨ AI 自动生成</button>
              <button class="btn ghost" @click="addAiTag">＋【AI工时】</button>
            </div>
            <div class="stats">
              <div class="stat"><b>{{ draft?.mineCount ?? 0 }}</b>总计底稿</div>
              <div class="stat green"><b>{{ draft?.closedTodayCount ?? 0 }}</b>当天关闭</div>
              <div class="stat amber"><b>{{ draft?.inProgressCount ?? 0 }}</b>进行中</div>
            </div>
            <div v-if="draft?.drafts?.length" class="draft-list">
              <div v-for="(d, i) in draft.drafts" :key="i" class="draft-item" :class="d.kind || ''">
                <div class="title">{{ d.title }}</div>
                <div class="meta">{{ d.meta }}</div>
              </div>
            </div>
            <label class="fld" style="margin-top:8px;flex:1;display:flex;flex-direction:column">
              <span class="lbl"><i class="req">*</i> 工作内容 <label class="chk"><input v-model="includeInprog" type="checkbox" @change="form.workDate && loadDrafts(form.workDate)"> 包含进行中</label></span>
              <textarea v-model="workContent" class="ipt ta" placeholder="先选日期 + 医院，然后点「AI 自动生成」..."></textarea>
            </label>
          </div>

          <div class="card">
            <div class="submit-bar">
              <div class="status" :class="statusMsg.kind">
                {{ statusMsg.text }}
                <details v-if="statusMsg.detail" class="detail"><summary>📋 查看提交数据</summary><pre>{{ statusMsg.detail }}</pre></details>
              </div>
              <button class="btn ghost" @click="previewSubmit">👁 预览</button>
              <button class="btn success" @click="doSubmit">✅ 确认提交</button>
            </div>
          </div>
        </template>

        <!-- 批量模式 -->
        <template v-else>
          <div class="card">
            <div class="grid6">
              <label class="fld"><span class="lbl"><i class="req">*</i> 填报日期</span><input v-model="allDate" type="date" class="ipt"></label>
              <label class="fld"><span class="lbl"><i class="req">*</i> 工序类型</span>
                <select v-model="allProcess" class="ipt"><option v-for="t in cfg?.processTypeOptions || []" :key="t.value" :value="t.value">{{ t.label }}</option></select>
              </label>
              <label class="fld"><span class="lbl">工时类型 / 条线</span>
                <span class="row2">
                  <select v-model="allType" class="ipt"><option v-for="t in cfg?.timesheetTypes || []" :key="t.value" :value="t.value">{{ t.label }}</option></select>
                  <select v-model="allCost" class="ipt"><option v-for="t in cfg?.costLineOptions || []" :key="t.value" :value="t.value">{{ t.label }}</option></select>
                </span>
              </label>
              <label class="fld"><span class="lbl">总工时</span><input v-model.number="allTotal" type="number" min="1" max="24" step="0.5" class="ipt"></label>
              <label class="fld"><span class="lbl">包含进行中</span><span class="chk" style="padding-top:8px"><input v-model="allIncludeInprog" type="checkbox" @change="loadAllDrafts"> 是</span></label>
              <label class="fld"><span class="lbl">&nbsp;</span>
                <span class="row2">
                  <button class="btn ghost" @click="redistributeAll">⚖ 重新均分</button>
                  <button class="btn primary" :disabled="allLoading" @click="loadAllDrafts">{{ allLoading ? '分析中...' : '⟳ 重新分析' }}</button>
                </span>
              </label>
            </div>
            <div class="all-summary">
              <span>全部医院（<b>{{ allRows.length }}</b> 家）</span>
              <span style="margin-left:auto">合计 <b>{{ allSum }}</b> / {{ allTarget }} 小时</span>
              <span class="diff" :class="allDiffKind">{{ allDiffKind === 'ok' ? '✅ 差值 0' : (allDiffKind === 'short' ? '还差 ' + Math.round((allTarget - allSum) * 100) / 100 + 'h' : '超出 ' + Math.round((allSum - allTarget) * 100) / 100 + 'h') }}</span>
              <button class="btn success" :disabled="!submittableRows.length" @click="submitAll">✅ 全部提交 ({{ submittableRows.length }})</button>
            </div>
            <div v-if="allWarning" class="warn-tip">⚠️ {{ allWarning }}</div>
            <div v-if="allStatus.text" class="status" :class="allStatus.kind" style="margin-top:8px">{{ allStatus.text }}</div>
          </div>

          <div class="all-area">
            <div v-if="!allRows.length" class="empty" style="padding:24px">进入全部模式后点「重新分析」自动加载（只显示当天有本人关闭底稿的医院）</div>
            <div v-for="r in allRows" :key="r.hospitalId" class="hosp-card">
              <div class="hosp-head" @click="r.expanded = !r.expanded">
                <span class="caret">{{ r.expanded ? '▾' : '▸' }}</span>
                <b>{{ r.hospitalName }}</b>
                <span class="badge green">当天关闭 {{ r.closedTodayCount }}</span>
                <span v-if="r.inProgressCount" class="badge amber">进行中 {{ r.inProgressCount }}</span>
                <span class="muted small">占比 {{ r.ratio }}%</span>
                <label class="hours" @click.stop>工时 <input v-model.number="r.hours" type="number" min="0" max="24" step="0.5"> h</label>
              </div>
              <div v-if="r.expanded" class="hosp-body">
                <div v-if="r._submitMsg" class="status" :class="r._submitMsg.startsWith('✅') ? 'success' : 'danger'">{{ r._submitMsg }}</div>
                <div class="row2" style="align-items:flex-end">
                  <label class="fld" style="flex:2"><span class="lbl">在建项目 <button class="linkbtn" type="button" @click="saveRowProject(r)">💾 记住</button></span>
                    <input v-model="r.inProjectId" type="text" class="ipt" placeholder="实施-无计划必填（如 154267）">
                  </label>
                  <label class="fld" style="flex:3"><span class="lbl">项目名称</span>
                    <input v-model="r.inProjectName" type="text" class="ipt">
                  </label>
                </div>
                <div v-if="r.topDrafts.length" class="draft-list" style="margin-top:6px">
                  <div v-for="(d, i) in r.topDrafts" :key="i" class="draft-item" :class="d.kind || ''">
                    <div class="title">{{ d.title }}</div>
                    <div class="meta">{{ d.meta }}</div>
                  </div>
                </div>
                <textarea v-model="r.workContent" class="ipt ta" style="min-height:80px;margin-top:6px"></textarea>
              </div>
            </div>
          </div>
        </template>
      </section>
    </div>

    <!-- 知识库弹框 -->
    <div v-if="kbOpen" class="modal-mask" @click.self="kbOpen = false">
      <div class="modal">
        <div class="modal-head"><b>📖 工时工作知识库（{{ kbTotal }}）</b><button class="btn ghost" @click="kbOpen = false">✕</button></div>
        <div class="modal-body">
          <div class="row2" style="margin-bottom:10px">
            <input v-model="kbInput" class="ipt" placeholder="添加一条常用工作内容，如「HIS 系统日常巡检与用户支持」" @keyup.enter="kbAdd">
            <button class="btn primary" :disabled="kbBusy" @click="kbAdd">添加</button>
          </div>
          <div v-if="!kbItems.length" class="empty">知识库为空，添加几条常用工作内容吧（存在 WXP 系统本地）</div>
          <div v-for="(t, i) in kbItems" :key="i" class="kb-row">
            <span class="kb-text">{{ t }}</span>
            <button class="btn ghost danger" @click="kbDelete(i)">✕</button>
          </div>
        </div>
      </div>
    </div>

    <!-- toast -->
    <div v-if="toast.show" class="toast" :class="toast.kind">{{ toast.text }}</div>
  </div>
</template>

<style scoped>
.ts { display: flex; flex-direction: column; gap: 12px; height: 100%; }
.ts-banner { display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px; }
.ts-main { display: flex; gap: 14px; flex: 1; min-height: 0; }
.ts-left { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.ts-right { flex: 1; display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow-y: auto; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-sm); padding: 12px 14px; }
.card.grow { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.card-title { font-size: 13px; font-weight: 650; color: var(--text); margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.err { color: var(--danger); font-size: 12.5px; margin-top: 6px; }
.ipt {
  width: 100%; padding: 7px 10px; border: 1px solid var(--border-strong); border-radius: 8px;
  background: var(--panel); color: var(--text); font-size: 13px; box-sizing: border-box;
}
.ipt:focus { outline: 2px solid var(--primary); outline-offset: -1px; border-color: var(--primary); }
.ipt[readonly] { background: var(--panel-2); color: var(--muted); }
.ta { flex: 1; resize: vertical; min-height: 120px; line-height: 1.6; }
.row2 { display: flex; gap: 6px; align-items: center; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.grid6 { display: grid; grid-template-columns: repeat(6, auto); gap: 10px; align-items: end; }
.fld { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.lbl { font-size: 12px; color: var(--muted); font-weight: 500; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.req { color: var(--danger); font-style: normal; }
.chk { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: 12px; color: var(--muted); }
.btn {
  padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border-strong);
  background: var(--panel); color: var(--text); font-size: 13px; cursor: pointer; white-space: nowrap;
}
.btn:hover { border-color: var(--primary); color: var(--primary); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.primary:hover { background: var(--primary-d); color: #fff; }
.btn.success { background: #10b981; border-color: #10b981; color: #fff; }
.btn.success:hover { background: #059669; border-color: #059669; color: #fff; }
.btn.ghost { background: var(--panel-2); }
.btn.ghost.danger:hover { border-color: var(--danger); color: var(--danger); }
.btn.block { width: 100%; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.linkbtn { border: none; background: none; color: var(--primary); cursor: pointer; font-size: 11.5px; padding: 0; }
.date-list { flex: 1; overflow-y: auto; min-height: 80px; display: flex; flex-direction: column; gap: 6px; }
.date-chip {
  padding: 8px 10px; border-radius: 8px; cursor: pointer; border: 1px solid var(--border);
  background: var(--panel); color: var(--text); font-size: 13px; text-align: left; transition: all .12s;
}
.date-chip:hover { border-color: var(--primary); background: #eef2ff; }
.date-chip.active { border-color: var(--primary); background: var(--primary); color: #fff; }
.empty { text-align: center; color: var(--muted); font-size: 12.5px; padding: 16px 0; }
.stats { display: flex; gap: 10px; margin-bottom: 10px; }
.stat { flex: 1; padding: 8px 10px; border-radius: 8px; background: var(--panel-2); font-size: 12px; color: var(--muted); text-align: center; }
.stat b { display: block; font-size: 18px; color: var(--primary); }
.stat.green b { color: #10b981; }
.stat.amber b { color: #f59e0b; }
.draft-list { max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.draft-item { padding: 6px 10px; background: var(--panel-2); border-radius: 6px; font-size: 12px; border-left: 3px solid var(--primary); }
.draft-item.closed { border-left-color: #10b981; }
.draft-item.inprog { border-left-color: #f59e0b; }
.draft-item .title { font-weight: 500; color: var(--text); }
.draft-item .meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
.submit-bar { display: flex; gap: 8px; align-items: flex-start; }
.status { flex: 1; font-size: 13px; color: var(--muted); white-space: pre-wrap; word-break: break-all; }
.status.success { color: #065f46; background: #ecfdf5; padding: 8px 10px; border-radius: 6px; border-left: 3px solid #10b981; }
.status.danger { color: #991b1b; background: #fef2f2; padding: 8px 10px; border-radius: 6px; border-left: 3px solid var(--danger); }
.status.info { color: #1e40af; background: #eff6ff; padding: 8px 10px; border-radius: 6px; border-left: 3px solid #3b82f6; }
.detail summary { cursor: pointer; font-size: 12px; color: var(--primary); margin-top: 6px; }
.detail pre { background: #1e293b; color: #e2e8f0; padding: 8px 10px; border-radius: 6px; font-size: 12px; max-height: 260px; overflow: auto; }
.all-summary { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; margin-top: 10px; font-size: 13px; }
.diff { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
.diff.ok { background: #d1fae5; color: #065f46; }
.diff.warn { background: #fef3c7; color: #92400e; }
.diff.short { background: #fee2e2; color: #b91c1c; font-weight: 600; }
.warn-tip { margin-top: 8px; font-size: 12.5px; color: #92400e; background: #fef3c7; padding: 6px 10px; border-radius: 6px; }
.all-area { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-left: 10px; border-left: 2px dashed var(--border); margin-left: 4px; }
.hosp-card { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); overflow: hidden; }
.hosp-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; font-size: 13px; flex-wrap: wrap; }
.hosp-head:hover { background: var(--panel-2); }
.caret { color: var(--muted); font-size: 11px; width: 12px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; }
.badge.green { background: #d1fae5; color: #065f46; }
.badge.amber { background: #fef3c7; color: #92400e; }
.hours { margin-left: auto; display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text); }
.hours input { width: 56px; text-align: center; padding: 2px 4px; border: 1px solid var(--border-strong); border-radius: 4px; font-size: 12px; }
.hosp-body { padding: 4px 12px 12px; border-top: 1px solid var(--border); background: var(--panel-2); }
.ts-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--muted); }
.ts-empty-icon { font-size: 42px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, .45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { width: min(640px, 92vw); max-height: 80vh; background: var(--panel); border-radius: 14px; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); font-size: 14.5px; }
.modal-body { padding: 14px 16px; overflow-y: auto; }
.kb-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; border-bottom: 1px dashed var(--border); font-size: 12.5px; }
.kb-row:last-child { border-bottom: none; }
.kb-text { flex: 1; word-break: break-all; }
.toast { position: fixed; right: 24px; bottom: 64px; z-index: 70; padding: 10px 16px; border-radius: 10px; color: #fff; font-size: 13px; box-shadow: var(--shadow); background: #3b82f6; }
.toast.success { background: #10b981; }
.toast.danger { background: var(--danger); }
.toast.warn { background: #f59e0b; }
@media (max-width: 1080px) {
  .ts-main { flex-direction: column; }
  .ts-left { width: auto; }
  .grid3, .grid6 { grid-template-columns: 1fr 1fr; }
}
</style>
