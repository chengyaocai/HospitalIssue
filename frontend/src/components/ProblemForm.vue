<script setup>
import { reactive, ref, watch, onMounted, computed } from 'vue';
import { api, TYPES, SEVERITIES, STATUSES, DEPARTMENTS } from '../api.js';

const props = defineProps({ initial: Object, canDelete: Boolean, currentUser: Object });
const emit = defineEmits(['submit', 'close', 'refresh']);

const empty = {
  title: '', department: '', reporter: '', contact: '',
  type: '故障', severity: '中', status: '待处理',
  description: '',
  registrar: '', handler: '', softwareSystem: '', resolution: '',
};
const form = reactive({ ...empty });
const attachments = ref([]);
const pendingFiles = ref([]);   // 新建态：尚未落库，随表单一并提交
const uploading = ref(false);
const dragActive = ref(false);

// 下拉数据源：处理人候选派生自本机构的「公司用户」（config.handlers，后端实时生成）；
// 软件系统来自系统设置；登记人来自用户花名册
const cfg = ref({ handlers: [], softwareSystems: [] });
const users = ref([]);

// 处理人候选：后端返回 { empId, name, phone }（v1.18.16 起为公司用户派生），
// 此处兼容旧纯文本形态，统一取姓名。
const handlerInfo = computed(() => {
  const m = {};
  for (const h of (cfg.value.handlers || [])) {
    if (h && typeof h === 'object' && h.name) m[h.name] = h;
    else if (typeof h === 'string' && h.trim()) m[h.trim()] = { empId: '', name: h.trim(), phone: '' };
  }
  return m;
});
const handlerOptions = computed(() => {
  const names = (cfg.value.handlers || [])
    .map((h) => (h && typeof h === 'object' ? h.name : (typeof h === 'string' ? h : '')))
    .filter(Boolean);
  return unique([...names, form.handler]).filter(Boolean);
});
const systemOptions = computed(() => unique([...cfg.value.softwareSystems, form.softwareSystem]).filter(Boolean));
const userOptions = computed(() => users.value || []);

// 下拉文案：姓名（工号）；悬停提示联系电话。
function handlerLabel(name) {
  const h = handlerInfo.value[name];
  return name + (h && h.empId ? '（' + h.empId + '）' : '');
}
function handlerTitle(name) {
  const h = handlerInfo.value[name];
  return h && h.phone ? '联系电话：' + h.phone : '';
}

function unique(arr) { return [...new Set(arr)]; }

onMounted(async () => {
  try { cfg.value = await api.getConfig(); } catch { /* 配置可选 */ }
  try { users.value = await api.listUsersLookup(); } catch { /* 用户列表可选 */ }
  // 新建时默认登记人为当前登录账号人员名
  if (!props.initial?.id && props.currentUser) {
    form.registrar = props.currentUser.name || props.currentUser.username || '';
  }
});

watch(
  () => props.initial,
  (v) => {
    Object.assign(form, empty, v || {});
    attachments.value = Array.isArray(v?.attachments) ? [...v.attachments] : [];
    pendingFiles.value = [];
    if (!v?.id) {
      const cu = props.currentUser;
      if (cu) form.registrar = cu.name || cu.username || '';
    }
  },
  { immediate: true }
);

function submit() {
  const data = {};
  for (const k of Object.keys(empty)) data[k] = (form[k] ?? '').toString().trim();
  const files = pendingFiles.value.map((p) => p.file);
  pendingFiles.value = [];
  emit('submit', { data, files });
}

// ---- 附件：编辑态直接上传；新建态先缓存，保存后再上传 ----
async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  for (const f of files) {
    if (props.initial?.id) await uploadImmediate(f);
    else pendingFiles.value.push({ name: f.name, size: f.size, file: f });
  }
}
async function uploadImmediate(file) {
  uploading.value = true;
  try {
    const att = await api.uploadAttachment(props.initial.id, file);
    attachments.value.push(att);
    emit('refresh');
  } catch (err) {
    alert(err.message || '上传失败');
  } finally {
    uploading.value = false;
  }
}
function onPick(e) { addFiles(e.target.files); e.target.value = ''; }
function onDrop(e) { dragActive.value = false; addFiles(e.dataTransfer?.files); }
function removePending(i) { pendingFiles.value.splice(i, 1); }

async function download(att) {
  try {
    await api.downloadAttachment(props.initial.id, att.id, att.originalName);
  } catch (err) {
    alert(err.message || '下载失败');
  }
}
async function removeAtt(att) {
  if (!confirm(`确认删除附件「${att.originalName}」？`)) return;
  try {
    await api.deleteAttachment(props.initial.id, att.id);
    attachments.value = attachments.value.filter((a) => a.id !== att.id);
    emit('refresh');
  } catch (err) {
    alert(err.message || '删除失败');
  }
}
function sizeText(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
</script>

<template>
  <div class="modal-mask">
    <div class="modal wide">
      <h3>{{ initial ? '编辑问题' : '登记问题' }}</h3>
      <div class="grid">
        <label class="full">问题标题*<input v-model="form.title" placeholder="简要描述问题" /></label>
        <label>所属科室*
          <select v-model="form.department">
            <option value="">请选择</option>
            <option v-for="d in DEPARTMENTS" :key="d" :value="d">{{ d }}</option>
          </select>
        </label>
        <label>提出人*
          <input v-model="form.reporter" placeholder="问题提出人姓名" />
        </label>
        <label>联系方式<input v-model="form.contact" placeholder="电话 / 工号" /></label>
        <label>登记人*
          <select v-model="form.registrar">
            <option value="">请选择登记人</option>
            <option v-for="u in userOptions" :key="u.username" :value="u.name || u.username">
              {{ u.name || u.username }}（{{ u.username }}）
            </option>
          </select>
        </label>
        <label>问题类型*
          <select v-model="form.type">
            <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label>严重程度*
          <select v-model="form.severity">
            <option v-for="s in SEVERITIES" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label>状态
          <select v-model="form.status">
            <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label>处理人
          <select v-model="form.handler">
            <!-- v1.18.16：候选为空时在空态里说明来源（本机构无公司用户属预期，去用户管理/机构管理配置） -->
            <option value="">{{ handlerOptions.length ? '请选择处理人' : '请选择处理人（候选取自本机构的「公司用户」）' }}</option>
            <option v-for="h in handlerOptions" :key="h" :value="h" :title="handlerTitle(h)">{{ handlerLabel(h) }}</option>
          </select>
        </label>
        <label>软件系统
          <select v-model="form.softwareSystem">
            <option value="">请选择软件系统</option>
            <option v-for="s in systemOptions" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
      </div>
      <label class="full">问题描述*<textarea v-model="form.description" rows="3" placeholder="现象、影响范围、复现步骤等"></textarea></label>
      <label class="full">处理说明<textarea v-model="form.resolution" rows="2" placeholder="处理过程与结果（可选）"></textarea></label>

      <div class="attach">
        <div class="attach-head">
          <span>附件（{{ attachments.length + pendingFiles.length }}）</span>
          <label class="upload-btn" :class="{ busy: uploading }">
            <input type="file" multiple :disabled="uploading" hidden @change="onPick" />
            {{ uploading ? '上传中…' : '+ 添加附件' }}
          </label>
        </div>
        <div
          class="dropzone"
          :class="{ drag: dragActive }"
          @dragover.prevent="dragActive = true"
          @dragleave.prevent="dragActive = false"
          @drop.prevent="onDrop"
        >
          将文件拖拽到此处，或点击上方「+ 添加附件」
        </div>
        <ul v-if="pendingFiles.length" class="attach-list">
          <li v-for="(p, i) in pendingFiles" :key="'p' + i">
            <span class="att-name">{{ p.name }}</span>
            <span class="meta">{{ sizeText(p.size) }}</span>
            <span class="tag-new">待提交</span>
            <button class="danger small" @click="removePending(i)">移除</button>
          </li>
        </ul>
        <ul v-if="attachments.length" class="attach-list">
          <li v-for="a in attachments" :key="a.id">
            <a href="javascript:void(0)" @click="download(a)">{{ a.originalName }}</a>
            <span class="meta">{{ sizeText(a.size) }} · {{ a.uploadedBy }}</span>
            <button v-if="canDelete" class="danger small" @click="removeAtt(a)">删除</button>
          </li>
        </ul>
        <p v-if="!pendingFiles.length && !attachments.length" class="attach-empty">
          保存问题后即可上传，或先拖入文件随表单一并提交
        </p>
      </div>

      <div class="modal-actions">
        <button class="primary" @click="submit">保存</button>
        <button @click="emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dropzone {
  margin-top: 10px;
  border: 1.5px dashed var(--border-strong);
  border-radius: 12px;
  background: var(--panel-2);
  color: var(--muted);
  font-size: 13px;
  text-align: center;
  padding: 18px 12px;
  transition: border-color .15s, background .15s, color .15s;
}
.dropzone.drag {
  border-color: var(--primary);
  background: #eef4ff;
  color: var(--primary);
}
.upload-btn.busy { opacity: .6; pointer-events: none; }
.att-name { color: var(--text); font-size: 13px; }
.tag-new {
  font-size: 11px; color: #b45309; background: #fef3c7;
  padding: 1px 7px; border-radius: 999px;
}
</style>
