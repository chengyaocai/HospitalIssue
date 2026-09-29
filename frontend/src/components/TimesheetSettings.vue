<script setup>
// 工时配置（v1.18.43 建，v1.18.46 增强）：每个公司用户自己的工时记录。
// v1.18.46：① 绑定表数据源改为 /hospitals —— 按**登录用户**动态拉取本人 WXP 客户医院
//   （不再展示全局 Configs 写死的固定医院表）；绑定生效优先级 个人 > 自动匹配（按医院名检索
//   本人 PMIS 在建项目）> 系统默认（兜底），来源列四态标注。② 新增「服务连接（管理员）」卡：
//   PMIS-MCP Token 界面化更换（写回 Configs/mcp.json 自动备份，即时生效），非管理员自动隐藏。
// 密码只写不读：接口层永不回显（只返回 hasPassword），留空保存 = 保留原密码。
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const toast = ref('');
const toastKind = ref('success');

const hasOwn = ref(false);
const usingGlobalAccount = ref(true);
const hasSavedPassword = ref(false);

const wxpUserCode = ref('');
const wxpPassword = ref(''); // 只写：留空 = 保留已存密码
const defaults = ref({ timesheetType: '', costLineId: '', processType: '', workHours: '' });

const dicts = ref({ timesheetTypes: [], costLineOptions: [], processTypeOptions: [] });
// 绑定表（v1.18.46）：来自 /hospitals（按用户动态拉取），行含 source=own|auto|sys|none
const bindings = ref([]); // [{ hospitalId, hospitalName, inProjectId, inProjectName, source }]
const personalBindingCodes = ref(new Set());
const pendingClear = ref(new Set()); // 本次待清除的个人绑定（保存时以 null 提交）
const hospitalsMsg = ref('');

// 服务连接（管理员）：/server-config 非平台管理员 403 → 静默隐藏卡片
const serverShow = ref(false);
const server = ref(null);
const newToken = ref('');
const savingToken = ref(false);

// 选项目弹框
const projModal = ref(false);
const projRow = ref(null);
const projLoading = ref(false);
const projList = ref([]);
const projPick = ref('');

let toastTimer = null;
function showToast(msg, kind = 'success') {
  toast.value = msg;
  toastKind.value = kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, 3500);
}

async function load() {
  loading.value = true;
  try {
    const [mine, cfg] = await Promise.all([api.tsMyConfig(), api.tsConfig()]);
    if (mine.success) {
      hasOwn.value = mine.hasOwn;
      usingGlobalAccount.value = mine.usingGlobalAccount;
      hasSavedPassword.value = Boolean(mine.config?.hasPassword);
      wxpUserCode.value = mine.config?.wxpUserCode || '';
      wxpPassword.value = '';
      defaults.value = {
        timesheetType: mine.config?.defaults?.timesheetType ?? cfg.defaultTimesheetType ?? 2,
        costLineId: mine.config?.defaults?.costLineId ?? cfg.defaultCostLineId ?? 2,
        processType: mine.config?.defaults?.processType ?? cfg.defaultProcessType ?? 62,
        workHours: mine.config?.defaults?.workHours ?? cfg.defaultWorkHours ?? 8,
      };
      personalBindingCodes.value = new Set(Object.keys(mine.config?.bindings || {}));
    }
    dicts.value = {
      timesheetTypes: cfg.timesheetTypes || [],
      costLineOptions: cfg.costLineOptions || [],
      processTypeOptions: cfg.processTypeOptions || [],
    };
    pendingClear.value = new Set();
    // 绑定表：按登录用户拉取本人的客户医院（WXP），来源=个人>自动>系统默认（后端已合并好）
    try {
      const h = await api.tsHospitals();
      if (h.success) {
        bindings.value = (h.hospitals || []).map((x) => ({
          hospitalId: x.hospitalId,
          hospitalName: x.hospitalName,
          inProjectId: x.inProjectId,
          inProjectName: x.inProjectName || '',
          source: x.source || 'none',
        }));
        hospitalsMsg.value = '';
      } else {
        bindings.value = [];
        hospitalsMsg.value = h.message || '医院列表获取失败';
      }
    } catch (e) {
      bindings.value = [];
      hospitalsMsg.value = e.message || String(e);
    }
  } catch (e) {
    showToast('加载失败：' + (e.message || e), 'danger');
  } finally {
    loading.value = false;
  }
  // 服务连接（管理员）：非平台管理员 403 → 静默不显示
  try {
    server.value = await api.tsServerConfig();
    serverShow.value = true;
  } catch { serverShow.value = false; }
}

async function testLogin() {
  if (!wxpUserCode.value.trim()) { showToast('请先填写工号', 'warn'); return; }
  if (!wxpPassword.value && !hasSavedPassword.value) { showToast('请填写密码（或先保存过密码）', 'warn'); return; }
  testing.value = true;
  try {
    const d = await api.tsTestLogin({ wxpUserCode: wxpUserCode.value.trim(), wxpPassword: wxpPassword.value });
    showToast(d.message || (d.success ? '连接成功' : '连接失败'), d.success ? 'success' : 'danger');
  } catch (e) {
    showToast('测试失败：' + (e.message || e), 'danger');
  } finally {
    testing.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    // 只提交「个人」维度：个人绑定行（正集）+ 待清除项（null=后端删除该键）；
    // 自动匹配 / 系统默认的行是展示值，绝不写回个人配置（v1.18.46 起不再整表回写）
    const bindingsPayload = {};
    for (const b of bindings.value) {
      if (pendingClear.value.has(b.hospitalId)) bindingsPayload[b.hospitalId] = null;
      else if (personalBindingCodes.value.has(b.hospitalId) && Number(b.inProjectId) > 0) {
        bindingsPayload[b.hospitalId] = {
          hospitalName: b.hospitalName,
          inProjectId: Number(b.inProjectId),
          inProjectName: b.inProjectName || '',
        };
      }
    }
    const body = {
      wxpUserCode: wxpUserCode.value.trim(),
      defaults: {
        timesheetType: Number(defaults.value.timesheetType) || null,
        costLineId: Number(defaults.value.costLineId) || null,
        processType: Number(defaults.value.processType) || null,
        workHours: Number(defaults.value.workHours) || null,
      },
      bindings: bindingsPayload,
    };
    // 密码留空 = 保留已存密码（后端 patch 语义）
    if (wxpPassword.value) body.wxpPassword = wxpPassword.value;
    const d = await api.tsSaveMyConfig(body);
    if (!d.success) { showToast(d.message || '保存失败', 'danger'); return; }
    showToast('工时配置已保存（仅本人生效）', 'success');
    wxpPassword.value = '';
    await load();
  } catch (e) {
    showToast('保存失败：' + (e.message || e), 'danger');
  } finally {
    saving.value = false;
  }
}

function clearBinding(row) {
  if (!personalBindingCodes.value.has(row.hospitalId)) return; // 只清除个人绑定
  pendingClear.value = new Set([...pendingClear.value, row.hospitalId]);
  personalBindingCodes.value = new Set([...personalBindingCodes.value].filter((c) => c !== row.hospitalId));
  row.inProjectId = 0;
  row.inProjectName = '';
  row.source = 'none'; // 保存成功后 load() 会按 个人>自动>系统默认 重算展示
}

async function openProjects(row) {
  projRow.value = row;
  projPick.value = row.inProjectId && row.source === 'own' ? String(row.inProjectId) : '';
  projModal.value = true;
  projLoading.value = true;
  projList.value = [];
  try {
    const d = await api.tsProjects({ hospitalCode: row.hospitalId, hospitalName: row.hospitalName });
    if (d.success) projList.value = d.projects || [];
    else showToast(d.message || '项目候选获取失败', 'danger');
  } catch (e) {
    showToast('项目候选获取失败：' + (e.message || e), 'danger');
  } finally {
    projLoading.value = false;
  }
}

function confirmProject() {
  const p = projList.value.find((x) => String(x.inProjectId) === String(projPick.value));
  if (p && projRow.value) {
    projRow.value.inProjectId = p.inProjectId;
    projRow.value.inProjectName = p.inProjectName;
    projRow.value.source = 'own';
    personalBindingCodes.value = new Set([...personalBindingCodes.value, projRow.value.hospitalId]);
    pendingClear.value = new Set([...pendingClear.value].filter((c) => c !== projRow.value.hospitalId));
  }
  projModal.value = false;
}

async function saveToken() {
  if (!newToken.value.trim()) { showToast('请先粘贴新 token', 'warn'); return; }
  savingToken.value = true;
  try {
    const d = await api.tsUpdateServerToken(newToken.value.trim());
    showToast(d.message || (d.success ? 'Token 已更新' : '更新失败'), d.success ? 'success' : 'danger');
    if (d.success) {
      newToken.value = '';
      server.value = await api.tsServerConfig();
    }
  } catch (e) {
    showToast('更新失败：' + (e.message || e), 'danger');
  } finally {
    savingToken.value = false;
  }
}

const srcLabel = (s) => (s === 'own' ? '个人' : s === 'auto' ? '自动匹配' : s === 'sys' ? '系统默认' : '未绑定');
const bindingCount = computed(() => bindings.value.filter((b) => Number(b.inProjectId) > 0).length);
const ownBindingCount = computed(() => bindings.value.filter((b) => b.source === 'own').length);
const autoBindingCount = computed(() => bindings.value.filter((b) => b.source === 'auto').length);
const sysBindingCount = computed(() => bindings.value.filter((b) => b.source === 'sys').length);

onMounted(load);
</script>

<template>
  <section class="tsset">
    <div v-if="toast" class="toast" :class="toastKind">{{ toast }}</div>

    <div v-if="!loading && usingGlobalAccount" class="hint warn">
      ⚠️ 尚未配置个人 WXP 账号 —— 当前工时登记使用的是系统默认账号。填写并保存下方「我的 WXP 账号」后，将以你本人的身份登录 PMIS/WXP（底稿归属过滤也随之变为本人）。
    </div>
    <div v-else-if="!loading" class="hint ok">
      ✅ 正在使用个人配置（工号 {{ wxpUserCode || '—' }}）。未覆盖的医院绑定与默认值回落系统默认。
    </div>

    <div class="set-grid">
      <!-- 我的 WXP 账号 -->
      <div class="card">
        <div class="card-title">我的 WXP 账号</div>
        <label class="fld">工号（WXP/PMIS 登录账号）
          <input v-model="wxpUserCode" class="ipt" placeholder="如 11547" autocomplete="off">
        </label>
        <label class="fld">密码
          <input v-model="wxpPassword" class="ipt" type="password" :placeholder="hasSavedPassword ? '已设置（留空 = 不修改）' : '请输入密码'" autocomplete="new-password">
        </label>
        <div class="rowbtn">
          <button class="btn ghost" :disabled="testing" @click="testLogin">{{ testing ? '测试中...' : '测试连接' }}</button>
        </div>
        <div class="muted small" style="margin-top:8px">密码仅用于本系统代你登录 WXP 底稿系统，保存后不回显；知识库为全体同事共享，不随个人配置变化。</div>
      </div>

      <!-- 填报默认值 -->
      <div class="card">
        <div class="card-title">填报默认值</div>
        <div class="grid2">
          <label class="fld">工时类型
            <select v-model="defaults.timesheetType" class="ipt">
              <option v-for="t in dicts.timesheetTypes" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </label>
          <label class="fld">费用归属条线
            <select v-model="defaults.costLineId" class="ipt">
              <option v-for="t in dicts.costLineOptions" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </label>
          <label class="fld">工序类型
            <select v-model="defaults.processType" class="ipt">
              <option v-for="t in dicts.processTypeOptions" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </label>
          <label class="fld">默认工时（小时）
            <input v-model="defaults.workHours" class="ipt" type="number" min="0" max="24" step="0.5">
          </label>
        </div>
        <div class="muted small" style="margin-top:8px">保存后打开「工时登记」时按你的默认值预填；此前显示的是系统默认值。</div>
      </div>
    </div>

    <!-- 医院 → 在建项目绑定（v1.18.46：按登录用户动态拉取本人客户医院） -->
    <div class="card" style="margin-top:14px">
      <div class="card-title">医院 → 在建项目绑定
        <span class="muted small" style="margin-left:auto">共 {{ bindings.length }} 家，已绑 {{ bindingCount }} 家（个人 {{ ownBindingCount }} / 自动 {{ autoBindingCount }} / 系统默认 {{ sysBindingCount }}）</span>
      </div>
      <div v-if="hospitalsMsg" class="hint warn" style="margin:8px 0 0">⚠️ {{ hospitalsMsg }}（配置好上方工号并保存后，将按你的账号自动拉取客户医院）</div>
      <div class="table-wrap">
        <table class="tbl">
          <thead>
            <tr><th style="width:26%">医院</th><th>在建项目（个人 &gt; 自动匹配 &gt; 系统默认）</th><th style="width:96px">来源</th><th style="width:190px">操作</th></tr>
          </thead>
          <tbody>
            <tr v-if="!bindings.length && !hospitalsMsg"><td colspan="4" class="empty">暂无医院（需先在 WXP 系统里配置客户，或检查工号）</td></tr>
            <tr v-for="b in bindings" :key="b.hospitalId">
              <td>{{ b.hospitalName }}<span class="muted small">（{{ b.hospitalId }}）</span></td>
              <td>
                <template v-if="Number(b.inProjectId) > 0">{{ b.inProjectId }} · {{ b.inProjectName || '（未命名）' }}</template>
                <span v-else class="muted">未绑定（不进批量填报）</span>
              </td>
              <td><span class="src" :class="b.source === 'own' ? 'own' : b.source === 'auto' ? 'auto' : 'sys'">{{ srcLabel(b.source) }}</span></td>
              <td>
                <button class="btn ghost small" @click="openProjects(b)">选择项目</button>
                <button v-if="b.source === 'own'" class="btn ghost small" style="margin-left:6px" @click="clearBinding(b)">清除个人绑定</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="muted small" style="margin-top:8px">「自动匹配」= 按医院名在<b>你本人</b>的 PMIS 在建项目中检索（项目名/客户名包含医院名即命中）；如匹配不准，用「选择项目」改为个人绑定（个人优先）。未匹配且无系统默认时不进批量填报。</div>
      <div class="rowbtn" style="margin-top:12px">
        <button class="btn primary" :disabled="saving || loading" @click="save">{{ saving ? '保存中...' : '保存我的工时配置' }}</button>
      </div>
    </div>

    <!-- 服务连接（v1.18.46，仅平台管理员可见；非管理员接口 403 → 卡片隐藏） -->
    <div v-if="serverShow" class="card" style="margin-top:14px">
      <div class="card-title">服务连接（管理员）
        <span class="muted small" style="margin-left:auto">PMIS-MCP · 即时生效，无需重启</span>
      </div>
      <div class="grid2">
        <div class="fld">服务地址
          <div class="kv">{{ server?.url || '—' }}</div>
        </div>
        <div class="fld">当前 Token
          <div class="kv">{{ server?.tokenMasked || '（未配置）' }}</div>
        </div>
      </div>
      <label class="fld">更换 Token（粘贴 PMIS-MCP 的新 Bearer token，保存写回 Configs/mcp.json 并自动备份）
        <input v-model="newToken" class="ipt" type="password" placeholder="粘贴新 token" autocomplete="off">
      </label>
      <div v-if="server?.fromEnv" class="hint warn" style="margin-top:8px">⚠️ 当前 token 由环境变量 <b>PMIS_MCP_TOKEN</b> 覆盖，此处修改不会生效；请移除该环境变量并重启后端后再改。</div>
      <div class="rowbtn" style="margin-top:10px">
        <button class="btn ghost" :disabled="savingToken" @click="saveToken">{{ savingToken ? '更新中...' : '更新 Token' }}</button>
      </div>
    </div>

    <!-- 选项目弹框 -->
    <div v-if="projModal" class="modal-mask" @click.self="projModal = false">
      <div class="modal">
        <div class="modal-head">
          <b>选择在建项目 — {{ projRow?.hospitalName }}</b>
          <button class="btn ghost small" @click="projModal = false">关闭</button>
        </div>
        <div class="modal-body">
          <div v-if="projLoading" class="muted">候选加载中...</div>
          <div v-else-if="!projList.length" class="muted">没有检索到在建项目候选（按医院名模糊匹配 PMIS，可稍后重试）</div>
          <label v-for="p in projList" :key="p.inProjectId" class="proj-row" :class="{ picked: String(p.inProjectId) === String(projPick) }">
            <input type="radio" name="proj" :value="String(p.inProjectId)" v-model="projPick">
            <span class="proj-name">{{ p.inProjectId }} · {{ p.inProjectName }}</span>
            <span class="muted small">{{ p.executeStatus || '—' }}<template v-if="p.isConfigured"> · 当前绑定</template></span>
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn primary" :disabled="!projPick" @click="confirmProject">确定</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tsset { width: 100%; max-width: 1360px; margin: 0 auto; }
.toast { position: fixed; top: 62px; right: 20px; z-index: 60; padding: 9px 14px; border-radius: 8px; font-size: 13px; color: #fff; box-shadow: 0 6px 18px rgba(15, 34, 74, .18); }
.toast.success { background: #16a34a; }
.toast.danger { background: #dc2626; }
.toast.warn { background: #d97706; }
.hint { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
.hint.warn { background: #fef3c7; color: #92400e; }
.hint.ok { background: #dcfce7; color: #166534; }
.set-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 1100px) { .set-grid { grid-template-columns: 1fr; } }
.fld { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--text); margin-top: 10px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.rowbtn { display: flex; justify-content: flex-end; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border, #e5eaf2); vertical-align: top; }
.tbl th { color: var(--muted); font-weight: 600; white-space: nowrap; }
.empty { color: var(--muted); text-align: center; padding: 18px 0; }
.src { font-size: 12px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.src.own { background: #eef4ff; color: #1d4ed8; }
.src.auto { background: #ecfeff; color: #0e7490; }
.src.sys { background: #eef2f7; color: #64748b; }
.kv { font-size: 13px; padding: 7px 10px; background: var(--panel, #f5f7fb); border: 1px solid var(--border, #e5eaf2); border-radius: 8px; font-family: Consolas, Menlo, monospace; word-break: break-all; color: var(--text); min-height: 14px; }
.btn.small { padding: 4px 10px; font-size: 12px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 34, 74, .45); z-index: 70; display: flex; align-items: center; justify-content: center; }
.modal { background: var(--card, #fff); border-radius: 12px; width: min(680px, 92vw); max-height: 82vh; display: flex; flex-direction: column; box-shadow: 0 18px 50px rgba(15, 34, 74, .25); }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border, #e5eaf2); }
.modal-body { padding: 8px 16px; overflow-y: auto; }
.modal-foot { padding: 12px 16px; border-top: 1px solid var(--border, #e5eaf2); display: flex; justify-content: flex-end; }
.proj-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.proj-row:hover { background: rgba(59, 116, 246, .08); }
.proj-row.picked { background: rgba(59, 116, 246, .14); }
.proj-name { flex: 1; }
</style>
