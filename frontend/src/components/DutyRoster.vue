<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

// 值班表：全员可查看（只读）；具备「排班管理」权限者可增/删/改与复制上周排班；
// 平台管理员额外可用「跨机构同步」（v1.18.13，push 推给其他机构 / pull 从其他机构拉取；
// v1.18.18 起为带来源标记的镜像同步：新增 / 对齐更新 / 仅移除上次同步产生的条目）。
const props = defineProps({
  canManage: { type: Boolean, default: false },
  canPlatformAdmin: { type: Boolean, default: false },
});

const WEEKS = ['一', '二', '三', '四', '五', '六', '日'];
const pad = (n) => String(n).padStart(2, '0');
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return fmtLocal(d);
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return fmtLocal(d);
}
const TODAY = fmtLocal(new Date());

const now = new Date();
const cursor = ref({ y: now.getFullYear(), m: now.getMonth() + 1 });
const entries = ref([]);
const loading = ref(false);
const loadError = ref('');

// 编辑面板状态
const selectedDate = ref(null);
const handlers = ref([]);             // 处理人候选（config.handlers：v1.18.16 起派生自本机构的公司用户，结构仍为 { empId, name, phone }）
const handlersLoaded = ref(false);
const form = ref({ id: null, handlerUsername: '', handlerName: '', note: '' });
const saving = ref(false);

const monthLabel = computed(() => `${cursor.value.y} 年 ${cursor.value.m} 月`);

// 轻量 toast（v1.6）：替代 alert()；2.5s 自动消失，成功/错误两种配色，样式走主题变量。
// confirm() 保留（删除/复制为破坏性操作，仍需用户确认）。
const toast = ref({ show: false, text: '', kind: 'success' });
let toastTimer = null;
function showToast(text, kind = 'success') {
  toast.value = { show: true, text, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 2500);
}

// 月历网格：周一起始，含当月完整周（4~6 行），非当月日期置灰。
const grid = computed(() => {
  const { y, m } = cursor.value;
  const first = `${y}-${pad(m)}-01`;
  const start = mondayOf(first);
  const dim = new Date(y, m, 0).getDate(); // 当月天数（m 为 1~12）
  const last = `${y}-${pad(m)}-${pad(dim)}`;
  const end = addDaysStr(mondayOf(last), 6);
  const cells = [];
  const d = new Date(start + 'T00:00:00');
  while (cells.length < 42 && fmtLocal(d) <= end) {
    const ds = fmtLocal(d);
    cells.push({ date: ds, day: d.getDate(), inMonth: ds >= first && ds <= last, isToday: ds === TODAY });
    d.setDate(d.getDate() + 1);
  }
  return cells;
});

const entriesByDate = computed(() => {
  const map = new Map();
  for (const e of entries.value) {
    const k = String(e.date);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return map;
});
function entriesOf(date) { return entriesByDate.value.get(date) || []; }

const dayEntries = computed(() => (selectedDate.value ? entriesOf(selectedDate.value) : []));

// 今日值班横幅（数据范围始终覆盖今天，见 load()）
// 改为对象数组：{ name, phone }，phone 为空字符串时横幅只显示姓名（避免「☎ 」脏内容）。
const todayNames = computed(() =>
  entriesOf(TODAY).map((e) => {
    const info = infoOf(e.handlerName);
    return { name: e.handlerName, phone: info && info.phone ? info.phone : '' };
  })
);

// 候选名单来自 config.handlers（v1.18.16 起为「本机构公司用户」派生，结构 { empId, name, phone }），
// 按姓名查工号 / 电话用于展示；电话恒为空（用户数据无电话字段）→ 各展示点 v-if 空值降级，不显示脏内容。
function normHandler(x) {
  if (typeof x === 'string') { const n = x.trim(); return n ? { empId: '', name: n, phone: '' } : null; }
  if (x && typeof x === 'object') {
    const n = String(x.name ?? '').trim();
    if (!n) return null;
    return { empId: typeof x.empId === 'string' ? x.empId.trim() : '', name: n, phone: typeof x.phone === 'string' ? x.phone.trim() : '' };
  }
  return null;
}
const handlerMap = computed(() => {
  const m = {};
  for (const h of handlers.value) if (h.name) m[h.name] = h;
  return m;
});
// 下拉选项：过滤无姓名的脏数据
const handlerOptions = computed(() => handlers.value.filter((h) => h.name));
// 按值班人姓名现查候选信息（工号 / 电话），用于排班展示（排班记录本身不存这两项）。
function infoOf(name) { return handlerMap.value[name] || null; }

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const { y, m } = cursor.value;
    const first = `${y}-${pad(m)}-01`;
    const last = `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
    // 范围至少覆盖今天，保证「今日值班」横幅始终有数据
    const from = [first, TODAY].sort()[0];
    const to = [last, TODAY].sort()[1];
    entries.value = await api.listSchedules({ from, to });
  } catch (e) {
    loadError.value = e.message || '加载失败';
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function prevMonth() {
  const { y, m } = cursor.value;
  cursor.value = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  load();
}
function nextMonth() {
  const { y, m } = cursor.value;
  cursor.value = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  load();
}
function thisMonth() {
  cursor.value = { y: now.getFullYear(), m: now.getMonth() + 1 };
  load();
}

async function ensureHandlers() {
  if (handlersLoaded.value) return;
  try {
    const c = await api.getConfig();
    handlers.value = (Array.isArray(c.handlers) ? c.handlers : []).map(normHandler).filter((h) => h.name);
  } catch { /* 候选名单不可用时允许按姓名手填，静默即可 */ }
  handlersLoaded.value = true;
}

function openDay(cell) {
  if (!props.canManage) return;
  selectedDate.value = cell.date;
  resetForm();
  ensureHandlers();
}
function closeEditor() { selectedDate.value = null; }

function resetForm() {
  form.value = { id: null, handlerUsername: '', handlerName: '', note: '' };
}
function onPickHandler() {
  // 候选虽已是系统账号（公司用户），但排班记录仍只按姓名存、不带账号标识（展示时按姓名现查工号/电话）——行为与旧版一致。
  form.value.handlerUsername = '';
}
function editEntry(e) {
  form.value = { id: e.id, handlerUsername: e.handlerUsername || '', handlerName: e.handlerName || '', note: e.note || '' };
}
async function submitForm() {
  if (!selectedDate.value || saving.value) return;
  if (!form.value.handlerUsername && !form.value.handlerName) return;
  saving.value = true;
  try {
    const data = {
      date: selectedDate.value,
      handlerUsername: form.value.handlerUsername || '',
      handlerName: form.value.handlerName,
      note: form.value.note || '',
    };
    if (form.value.id) {
      await api.updateSchedule(form.value.id, data);
    } else {
      await api.createSchedule(data);
    }
    resetForm();
    await load();
    showToast(form.value.id ? '排班已更新' : '排班已添加');
  } catch (e) {
    showToast(e.message || '保存失败', 'error');
  } finally {
    saving.value = false;
  }
}
async function deleteEntry(e) {
  if (!confirm(`确认删除 ${e.date} 的排班「${e.handlerName}」？`)) return;
  try {
    await api.removeSchedule(e.id);
    if (form.value.id === e.id) resetForm();
    await load();
    showToast('排班已删除');
  } catch (err) {
    showToast(err.message || '删除失败', 'error');
  }
}

// 复制上周排班到本周（按今天所在周计算两个周一）
async function copyLastWeek() {
  const targetFrom = mondayOf(TODAY);
  const sourceFrom = addDaysStr(targetFrom, -7);
  const msg = `确认把上周（${sourceFrom} 起 7 天）的排班复制到本周（${targetFrom} 起 7 天）？\n目标周已存在的「同日同人」会自动跳过。`;
  if (!confirm(msg)) return;
  try {
    const r = await api.copySchedules({ sourceFrom, targetFrom });
    await load();
    showToast(`已复制 ${r.copied} 条排班${r.copied ? '' : '（目标周已存在，未新增）'}`);
  } catch (e) {
    showToast(e.message || '复制失败', 'error');
  }
}

// ===== 跨机构同步（v1.18.13，仅平台管理员）=====
const showSync = ref(false);
const syncBusy = ref(false);
const syncError = ref('');
const syncDirection = ref('push');   // 'push' = 推送到其他机构；'pull' = 从其他机构拉取
const syncOrgs = ref([]);            // 可选机构（/api/orgs 已排除当前机构与停用机构）
const syncPicked = ref([]);          // 勾选的机构 id（草稿状态，字符串数组）
const syncFrom = ref('');
const syncTo = ref('');

// 默认日期区间：与页面视图一致 —— 当前显示月为本月时取今天所在周（周一起 7 天），
// 翻到其它月份时取该月第一周；进入弹框时预填，可改。
function defaultSyncWeek() {
  const { y, m } = cursor.value;
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  return mondayOf(isCurrentMonth ? TODAY : `${y}-${pad(m)}-01`);
}

async function openSync() {
  syncError.value = '';
  syncDirection.value = 'push';
  syncPicked.value = [];
  const start = defaultSyncWeek();
  syncFrom.value = start;
  syncTo.value = addDaysStr(start, 6);
  showSync.value = true;
  try {
    const data = await api.listOrgs();
    const cur = String(data.current ?? '');
    syncOrgs.value = (data.orgs || []).filter((o) => String(o.id) !== cur && o.active !== false);
  } catch (e) {
    syncError.value = e.message || '机构列表加载失败';
  }
}
function closeSync() { showSync.value = false; }
function toggleSyncOrg(id) {
  const k = String(id);
  const i = syncPicked.value.indexOf(k);
  if (i === -1) syncPicked.value.push(k);
  else syncPicked.value.splice(i, 1);
}
async function submitSync() {
  if (syncBusy.value) return;
  syncError.value = '';
  if (!syncPicked.value.length) { syncError.value = '请至少选择一个机构'; return; }
  syncBusy.value = true;
  try {
    const r = await api.syncSchedules({
      direction: syncDirection.value,
      orgIds: syncPicked.value.map(Number),
      from: syncFrom.value,
      to: syncTo.value,
    });
    closeSync();
    await load();
    // v1.18.18：镜像同步结果 —— 新增 / 更新 / 移除三项计数；全为 0 时提示已一致。
    const changed = (r.totalCopied || 0) + (r.totalUpdated || 0) + (r.totalRemoved || 0);
    showToast(changed
      ? `同步完成：新增 ${r.totalCopied} 条、更新 ${r.totalUpdated} 条、移除 ${r.totalRemoved} 条`
      : '排班已一致，无需变更');
  } catch (e) {
    // 后端 400/403 的中文原因原样展示在弹框内，弹框不关闭
    syncError.value = e.message || '同步失败';
  } finally {
    syncBusy.value = false;
  }
}

onMounted(() => { load(); ensureHandlers(); });
</script>

<template>
  <section>
    <header class="page-head">
      <div>
        <h1>值班表</h1>
        <p class="sub">信息科值班安排 · 全员可查看<span v-if="canManage"> · 你具备排班管理权限</span></p>
      </div>
      <div class="actions" v-if="canManage">
        <button v-if="canPlatformAdmin" class="small" @click="openSync">跨机构同步</button>
        <button class="small" @click="copyLastWeek">复制上周排班到本周</button>
      </div>
    </header>

    <div class="duty-banner" :class="{ 'duty-banner-empty': !todayNames.length }">
      <span class="duty-banner-label">今日值班</span>
      <span v-if="todayNames.length" class="duty-banner-names">
        <span v-for="(t, i) in todayNames" :key="t.name + '|' + i" class="duty-banner-person-wrap">
          <span class="duty-banner-person">{{ t.name }}</span><span v-if="t.phone" class="duty-banner-phone"> ☎{{ t.phone }}</span><span v-if="i < todayNames.length - 1" class="duty-banner-sep">、</span>
        </span>
      </span>
      <span v-else class="duty-banner-none">今日无人值班</span>
    </div>

    <div class="duty-card">
      <div class="duty-toolbar">
        <button class="small" @click="prevMonth">‹ 上月</button>
        <button class="small" @click="thisMonth">回到本月</button>
        <button class="small" @click="nextMonth">下月 ›</button>
        <span class="duty-month">{{ monthLabel }}</span>
        <span v-if="loading" class="duty-loading">加载中…</span>
        <span v-if="loadError" class="duty-error">{{ loadError }}</span>
      </div>

      <div class="duty-cal">
        <div class="duty-cal-head">
          <div v-for="w in WEEKS" :key="w" class="duty-cal-hcell">{{ w }}</div>
        </div>
        <div class="duty-cal-grid">
          <div
            v-for="cell in grid"
            :key="cell.date"
            class="duty-cell"
            :class="{
              'duty-cell-other': !cell.inMonth,
              'duty-cell-today': cell.isToday,
              'duty-cell-clickable': canManage,
            }"
            :title="canManage ? '点击管理当日排班' : ''"
            @click="openDay(cell)"
          >
            <div class="duty-cell-date">
              <span>{{ cell.day }}</span>
              <span v-if="cell.isToday" class="duty-today-tag">今天</span>
            </div>
            <div class="duty-cell-body">
              <div v-for="e in entriesOf(cell.date)" :key="e.id" class="duty-chip" :title="infoOf(e.handlerName) ? ('电话：' + (infoOf(e.handlerName).phone || '—') + (infoOf(e.handlerName).empId ? '　工号：' + infoOf(e.handlerName).empId : '')) : ''">
                <span class="duty-chip-name">{{ e.handlerName }}</span>
                <span v-if="infoOf(e.handlerName) && infoOf(e.handlerName).phone" class="duty-chip-phone">☎ {{ infoOf(e.handlerName).phone }}</span>
                <span v-if="e.note" class="duty-chip-note">{{ e.note }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 排班编辑面板（仅 canManage） -->
    <div v-if="selectedDate" class="duty-mask">
      <div class="duty-panel">
        <div class="duty-panel-head">
          <h3>{{ selectedDate }} 排班</h3>
          <button class="small" @click="closeEditor">关闭</button>
        </div>

        <div class="duty-panel-list">
          <div v-if="!dayEntries.length" class="duty-panel-empty">当日暂无排班</div>
          <div v-for="e in dayEntries" :key="e.id" class="duty-panel-item">
            <div class="duty-panel-item-main">
              <b>{{ e.handlerName }}</b>
              <span v-if="infoOf(e.handlerName) && infoOf(e.handlerName).empId" class="duty-panel-user">工号 {{ infoOf(e.handlerName).empId }}</span>
              <span v-if="infoOf(e.handlerName) && infoOf(e.handlerName).phone" class="duty-panel-user">☎ {{ infoOf(e.handlerName).phone }}</span>
              <span v-if="e.note" class="duty-panel-note">{{ e.note }}</span>
            </div>
            <div class="duty-panel-item-ops">
              <button class="small" @click="editEntry(e)">改</button>
              <button class="small danger" @click="deleteEntry(e)">删</button>
            </div>
          </div>
        </div>

        <form class="duty-form" @submit.prevent="submitForm">
          <h4>{{ form.id ? '修改排班' : '新增排班' }}</h4>
          <label>处理人
            <select v-model="form.handlerName" @change="onPickHandler">
              <!-- v1.18.16：候选为空时在空态里说明来源（本机构无公司用户属预期，去用户管理/机构管理配置） -->
              <option value="">{{ handlerOptions.length ? '请选择处理人' : '请选择处理人（候选取自本机构的「公司用户」）' }}</option>
              <option v-for="h in handlerOptions" :key="(h.empId || '') + '|' + h.name" :value="h.name" :title="h.phone || ''">
                {{ h.name }}{{ h.empId ? '（' + h.empId + '）' : '' }}
              </option>
            </select>
          </label>
          <label>备注
            <input v-model="form.note" maxlength="200" placeholder="选填，如：白班 / 夜班" />
          </label>
          <div class="duty-form-ops">
            <button type="submit" class="primary" :disabled="saving || (!form.handlerUsername && !form.handlerName)">
              {{ form.id ? '保存修改' : '添加排班' }}
            </button>
            <button v-if="form.id" type="button" @click="resetForm">取消修改</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 跨机构同步弹框（v1.18.13；v1.18.18 升级为镜像同步。仅平台管理员）：遮罩点击不关闭（@click.self 陷阱留空）；错误显示在弹框内 -->
    <div v-if="showSync" class="duty-mask" @click.self="closeSync">
      <div class="duty-panel duty-sync-panel">
        <div class="duty-panel-head">
          <h3>跨机构同步排班</h3>
          <button class="small" @click="closeSync">关闭</button>
        </div>

        <div class="duty-sync-body">
          <div class="duty-sync-field">
            <span class="duty-sync-label">方向</span>
            <div class="duty-sync-direction">
              <label :class="{ picked: syncDirection === 'push' }">
                <input type="radio" value="push" v-model="syncDirection" /> 推送到其他机构
              </label>
              <label :class="{ picked: syncDirection === 'pull' }">
                <input type="radio" value="pull" v-model="syncDirection" /> 从其他机构拉取
              </label>
            </div>
          </div>

          <div class="duty-sync-field">
            <span class="duty-sync-label">{{ syncDirection === 'push' ? '推送目标机构' : '拉取来源机构' }}（可多选）</span>
            <div v-if="!syncOrgs.length" class="duty-sync-empty">暂无可选机构（需平台管理员先在「机构管理」中创建其他机构）</div>
            <div v-else class="duty-sync-orgs">
              <label v-for="o in syncOrgs" :key="o.id" class="duty-sync-org">
                <input
                  type="checkbox"
                  :checked="syncPicked.includes(String(o.id))"
                  @change="toggleSyncOrg(o.id)"
                />
                <span>{{ o.name }}</span>
              </label>
            </div>
          </div>

          <div class="duty-sync-dates">
            <label>开始日期 <input type="date" v-model="syncFrom" /></label>
            <label>结束日期 <input type="date" v-model="syncTo" /></label>
          </div>

          <p class="duty-sync-tip">同步会把所选时段的排班与源机构对齐：源里有而目标没有的新增、内容有变化的更新、上次同步产生但源里已删除的移除；手工排的班不受影响（不会被改也不会被删）。</p>
          <p v-if="syncError" class="duty-sync-error">{{ syncError }}</p>

          <div class="duty-sync-ops">
            <button class="primary" :disabled="syncBusy || !syncPicked.length" @click="submitSync">
              {{ syncBusy ? '同步中…' : '开始同步' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 轻量 toast（v1.6）：替代 alert，2.5s 自动消失 -->
    <transition name="duty-toast-fade">
      <div v-if="toast.show" class="duty-toast" :class="'duty-toast-' + toast.kind" role="status">
        <span class="duty-toast-dot"></span>{{ toast.text }}
      </div>
    </transition>
  </section>
</template>
