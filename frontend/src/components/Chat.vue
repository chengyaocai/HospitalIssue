<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { api } from '../api.js';
import { unread, refreshUnread, setUnread } from '../chat.js';
import Tabs from './Tabs.vue';

const props = defineProps({
  currentUser: Object,
  canUse: { type: Boolean, default: false },
  // v1.18.22：是否可查看问题登记视图（决定引用卡片是否可点击跳详情；无权限则卡片不可点、cursor 默认）
  canViewIssues: { type: Boolean, default: false },
});

const emit = defineEmits(['open-issue']);

const me = computed(() => props.currentUser?.username || '');
const meName = computed(() => props.currentUser?.name || me.value);

const conversations = ref([]);
const activeId = ref(null);
const messages = ref([]);
const nameMap = ref({});   // username -> 姓名（会话标题 / 发言人显示用）
const filter = ref('all'); // all | ai | user
const draft = ref('');
const loading = ref(false);
const loadingMsg = ref(false);
const sending = ref(false);
const error = ref('');

// 新建会话弹框
const showNew = ref(false);
const users = ref([]);
const picked = ref([]); // 选中的 username
const newTitle = ref('');
const usersLoading = ref(false);

// v1.18.29：选成员列表按用户类型分二级 sheet 页（与用户管理 v1.18.15 同款交互）
const memberTabs = [
  { key: 'all', label: '全部' },
  { key: 'hospital', label: '院方用户' },
  { key: 'company', label: '公司用户' },
];
const pickedType = ref('all');
// visibleUsers：按 sheet 页过滤。userType 缺失（旧后端未升级）归院方侧，
// 保证任何一条记录至少落在一个 sheet 页里，不会出现「两个页都不显示」。
const visibleUsers = computed(() => {
  if (pickedType.value === 'hospital') return users.value.filter((u) => u.userType !== 'company');
  if (pickedType.value === 'company') return users.value.filter((u) => u.userType === 'company');
  return users.value;
});

// 附件（图片 / 文件）：pending = 已上传、待随消息发送的附件元数据
const pending = ref([]);
const uploading = ref(false);
const fileInput = ref(null);
const attBlobs = ref({});     // storedName -> objectURL（图片预览）
const previewAtt = ref(null); // 正在放大预览的图片附件
const MAX_ATT = 10;

const POLL_MS = 15000;
let pollTimer = null;

const filtered = computed(() => {
  if (filter.value === 'ai') return conversations.value.filter((c) => c.type === 'ai');
  if (filter.value === 'user') return conversations.value.filter((c) => c.type === 'user');
  return conversations.value;
});

const activeConv = computed(() => conversations.value.find((c) => c.id === activeId.value) || null);

// 显示用姓名：优先中文姓名，取不到时回退用户名
function displayName(username) { return nameMap.value[username] || username || ''; }

// 会话展示名：AI 固定；同事会话显示「除自己外的成员姓名 / 或自定义标题」
function convTitle(c) {
  if (c.type === 'ai') return 'AI 智能助手';
  const members = c.members || [];
  const peers = members.filter((m) => m !== me.value);
  // 自定义标题优先（「成员用户名拼接」视为自动标题，改渲染姓名）
  const isAuto = !c.title || c.title === members.join('、');
  if (c.title && !isAuto) return c.title;
  const list = peers.length ? peers : members;
  return list.map(displayName).join('、') || meName.value || me.value;
}

function peerNames(c) {
  const peers = (c.members || []).filter((m) => m !== me.value);
  return peers.map(displayName).join('、');
}

async function loadConversations() {
  loading.value = true;
  error.value = '';
  try {
    const list = await api.listConversations();
    conversations.value = list || [];
    const total = (list || []).reduce((s, c) => s + (c.unread || 0), 0);
    setUnread(total);
  } catch (e) {
    error.value = e.message || '加载会话失败';
    conversations.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadMessages() {
  if (!activeId.value) return;
  loadingMsg.value = true;
  try {
    const list = await api.listMessages(activeId.value, { limit: 200 });
    messages.value = list || [];
    loadMessageBlobs(messages.value);   // 图片附件异步取回（带鉴权头）
    await nextTick(scrollBottom);
  } catch (e) {
    error.value = e.message || '加载消息失败';
  } finally {
    loadingMsg.value = false;
  }
}

async function selectConv(id) {
  activeId.value = id;
  draft.value = '';
  pending.value = [];
  previewAtt.value = null;
  try { await api.markChatRead(id); } catch { /* 忽略 */ }
  await loadMessages();
}

// 顶部「AI 智能助手」快捷入口：确保存在专属会话并打开
async function openAi() {
  try {
    const conv = await api.chatAiConversation();
    if (!conversations.value.find((c) => c.id === conv.id)) conversations.value.unshift(conv);
    await selectConv(conv.id);
  } catch (e) { error.value = e.message || '打开 AI 助手失败'; }
}

async function send() {
  const text = draft.value.trim();
  const atts = pending.value.slice();
  if ((!text && !atts.length) || !activeId.value || sending.value || uploading.value) return;
  if (!props.canUse) { error.value = '无聊天权限'; return; }
  sending.value = true;
  error.value = '';
  try {
    await api.sendChatMessage(activeId.value, text, atts);
    draft.value = '';
    pending.value = [];
    await loadMessages();        // 同事会话：拿到自己刚发的；AI 会话：同时拿到助手回复
    await loadConversations();   // 刷新会话列表的最后一条 / 未读
    await nextTick(scrollBottom);
  } catch (e) {
    error.value = e.message || '发送失败';
  } finally {
    sending.value = false;
  }
}

async function openNew() {
  showNew.value = true;
  picked.value = [];
  pickedType.value = 'all'; // v1.18.29：打开弹框时类型 sheet 页重置回「全部」
  newTitle.value = '';
  usersLoading.value = true;
  try {
    const list = await api.listUsersLookup();
    // 排除自己
    users.value = (list || []).filter((u) => u.username !== me.value);
  } catch (e) {
    error.value = e.message || '加载用户列表失败';
    users.value = [];
  } finally {
    usersLoading.value = false;
  }
}
function togglePick(u) {
  const i = picked.value.indexOf(u);
  if (i >= 0) picked.value.splice(i, 1); else picked.value.push(u);
}
async function createNew() {
  if (!picked.value.length) { error.value = '请至少选择 1 位成员'; return; }
  if (!props.canUse) { error.value = '无聊天权限'; return; }
  try {
    const conv = await api.createConversation({ type: 'user', members: picked.value, title: newTitle.value.trim() || undefined });
    showNew.value = false;
    conversations.value.unshift(conv);
    await selectConv(conv.id);
  } catch (e) { error.value = e.message || '创建会话失败'; }
}

const box = ref(null);
function scrollBottom() {
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function msgClass(m) {
  if (m.sender === me.value) return 'me';
  if (m.sender === 'assistant') return 'ai';
  return 'other';
}

// v1.18.39：自己发送的消息在时间旁显示「已读/未读」回执（仅用户会话；AI 会话无对方已读概念）。
// read_by 为已读用户名列表（后端 mapMsg 出口已带）；任一其他成员读过即「已读」。
// 回执随 15s 轮询（tick→loadMessages）自动刷新，无需额外处理。
function msgReceipt(m) {
  if (!activeConv.value || activeConv.value.type !== 'user') return null;
  if (m.sender !== me.value) return null;
  const others = (m.read_by || []).filter((u) => u && u !== me.value);
  return others.length ? '已读' : '未读';
}

// v1.18.22：点击聊天气泡里的「问题引用」卡片 → 事件上抛到 App，由 App 切换视图并打开详情。
// 无 canViewIssues 权限时卡片不可点（模板里也不绑定点击），cursor 维持默认。
function onRefClick(ref) {
  if (!props.canViewIssues || !ref) return;
  emit('open-issue', ref.id);
}

// ---- 附件（图片 / 文件）----
function isImageAtt(att) {
  const t = (att.type || '').toLowerCase();
  if (t) return t.startsWith('image/');
  return /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(att.originalName || '');
}
function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}
function attSrc(att) { return (att && attBlobs.value[att.storedName]) || ''; }

// 上传选中的文件（含剪贴板粘贴、拖拽、选择器），逐个上传并加入待发送列表
async function uploadFiles(list) {
  const files = Array.from(list || []).filter(Boolean);
  if (!files.length) return;
  if (!activeId.value) { error.value = '请先选择会话'; return; }
  if (!props.canUse) { error.value = '无聊天权限'; return; }
  uploading.value = true;
  error.value = '';
  try {
    for (const f of files) {
      if (pending.value.length >= MAX_ATT) { error.value = `最多上传 ${MAX_ATT} 个附件`; break; }
      try {
        const att = await api.uploadChatAttachment(activeId.value, f);
        // 本地先用原始 File 生成图片缩略图，避免等下一次拉取
        if (isImageAtt(att)) {
          try { attBlobs.value[att.storedName] = URL.createObjectURL(f); } catch { /* 忽略 */ }
        }
        pending.value.push(att);
      } catch (e) {
        error.value = e.message || '附件上传失败';
      }
    }
  } finally {
    uploading.value = false;
  }
}
function onPaste(e) {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) { e.preventDefault(); uploadFiles(files); }
}
function onDrop(e) {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) { e.preventDefault(); uploadFiles(files); }
}
function pickFiles() { if (fileInput.value) fileInput.value.click(); }
function onFilePicked(e) { uploadFiles(e.target.files); e.target.value = ''; }
function removePending(i) { pending.value.splice(i, 1); }

// 消息里的图片附件：带鉴权头取回 blob 再转 objectURL（<img> 无法直接带 token）
function loadMessageBlobs(list) {
  for (const m of list || []) {
    for (const att of (m.attachments || [])) {
      if (!isImageAtt(att)) continue;
      if (att.storedName in attBlobs.value) continue;
      attBlobs.value[att.storedName] = '';   // 占位，避免重复请求
      api.chatAttachmentBlob(att.storedName)
        .then((b) => { attBlobs.value[att.storedName] = URL.createObjectURL(b); })
        .catch(() => { /* 加载失败保持占位 */ });
    }
  }
}
async function downloadAtt(att) {
  try { await api.downloadChatAttachment(att.storedName, att.originalName); }
  catch (e) { error.value = e.message || '下载失败'; }
}

function tick() {
  refreshUnread();
  loadConversations();
  if (activeId.value) loadMessages();
}

// ---- 撤回 / 复制 / 移除会话（v1.18.14）----
// 轻量 toast（与 DutyRoster 同款交互）：2.5s 自动消失
const toast = ref({ show: false, text: '', kind: 'success' });
let toastTimer = null;
function showToast(text, kind = 'success') {
  toast.value = { show: true, text, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 2500);
}

// 复制正文：优先 clipboard API；内网 HTTP 环境无该 API，
// 回退「隐藏 textarea + execCommand('copy')」兜底。
async function copyMessage(m) {
  const text = m.body || '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast('已复制');
      return;
    }
    throw new Error('no clipboard api');
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (!ok) throw new Error('copy failed');
      showToast('已复制');
    } catch {
      showToast('复制失败', 'error');
    }
  }
}

// 撤回资格（v1.18.33 放宽）：会话内任何未撤回的消息都可撤回（含对方发送的）；
// 后端以会话成员身份兜底（非成员 404）。
function canRecall(m) {
  return !m.recalled;
}

async function recallMsg(m) {
  if (!activeId.value) return;
  try {
    await api.recallMessage(activeId.value, m.id);
    await loadMessages();       // 重新拉取：接口层已把正文屏蔽成墓碑占位
    await loadConversations();  // 最后一条消息若是被撤回的那条，列表预览也要刷新
  } catch (e) {
    showToast(e.message || '撤回失败', 'error');
  }
}

// 移除会话：AI 会话=删除（下次发消息自动新建）；同事会话=退出（他人不受影响）。
async function removeConv(c) {
  const isAi = c.type === 'ai';
  const tip = isAi
    ? '删除该 AI 会话及其全部消息？下次发消息会自动新建会话。'
    : '退出该会话？退出后你将不再收到该会话的消息，其他成员不受影响。';
  if (!window.confirm(tip)) return;
  try {
    const r = await api.removeConversation(c.id);
    if (activeId.value === c.id) { activeId.value = null; messages.value = []; }
    await loadConversations();
    showToast(r && r.removed === 'all' ? '已删除会话' : '已退出会话');
  } catch (e) {
    showToast(e.message || '操作失败', 'error');
  }
}

// 载入「用户名 -> 姓名」映射（取不到则回退用户名显示）
async function loadNames() {
  try {
    const list = await api.listUsersLookup();
    const m = {};
    for (const u of (list || [])) m[u.username] = u.name || u.username;
    nameMap.value = m;
  } catch { /* 静默：回退用户名 */ }
}

onMounted(async () => {
  await loadNames();
  await loadConversations();
  await openAi(); // 默认打开 AI 助手会话
  pollTimer = setInterval(tick, POLL_MS);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  // 释放图片预览 blob，避免内存泄漏
  for (const u of Object.values(attBlobs.value)) { if (u) { try { URL.revokeObjectURL(u); } catch { /* 忽略 */ } } }
});

watch(activeId, () => { if (activeId.value) nextTick(scrollBottom); });
</script>

<template>
  <section class="chat">
    <aside class="chat-side">
      <div class="side-head">
        <div class="seg">
          <button :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
          <button :class="{ on: filter === 'ai' }" @click="filter = 'ai'">AI 助手</button>
          <button :class="{ on: filter === 'user' }" @click="filter = 'user'">同事</button>
        </div>
        <button v-if="canUse" class="new-btn" @click="openNew">+ 新建会话</button>
      </div>

      <button class="ai-entry" @click="openAi">
        <span class="ai-ico">🤖</span>
        <span>AI 智能助手</span>
      </button>

      <div class="conv-list">
        <p v-if="loading" class="side-tip">加载中…</p>
        <p v-else-if="!filtered.length" class="side-tip">暂无会话</p>
        <div
          v-for="c in filtered" :key="c.id"
          class="conv-item" :class="{ active: c.id === activeId }"
          @click="selectConv(c.id)"
        >
          <div class="conv-ava" :class="{ ai: c.type === 'ai' }">{{ c.type === 'ai' ? '🤖' : (convTitle(c).slice(0, 1)) }}</div>
          <div class="conv-meta">
          <div class="conv-top">
            <div class="conv-name-wrap">
              <span class="conv-name">{{ convTitle(c) }}</span>
              <!-- v1.18.37：每个会话显式显示已读/未读状态；未读=红胶囊+圆点，已读=灰色「已读」 -->
              <span class="conv-status" :class="c.unread ? 'unread' : 'read'">
                <i class="dot" v-if="c.unread"></i>{{ c.unread ? '未读' : '已读' }}
              </span>
            </div>
            <span v-if="c.unread" class="conv-badge">{{ c.unread > 99 ? '99+' : c.unread }}</span>
          </div>
            <div class="conv-last">{{ c.lastMessage || '（暂无消息）' }}</div>
          </div>
          <!-- 移除（v1.18.14）：AI 会话=删除；同事会话=退出。@click.stop 避免触发打开会话 -->
          <button class="conv-remove" :title="c.type === 'ai' ? '删除会话' : '退出会话'" @click.stop="removeConv(c)">✕</button>
        </div>
      </div>
    </aside>

    <div class="chat-main" @dragover.prevent @drop.prevent="onDrop">
      <header class="chat-main-head" v-if="activeConv">
        <div>
          <h3>{{ convTitle(activeConv) }}</h3>
          <p class="sub" v-if="activeConv.type === 'user'">{{ peerNames(activeConv) }}</p>
          <p class="sub" v-else>智能问答 · 当前为框架占位（模型稍后接入）</p>
        </div>
      </header>
      <div v-else class="chat-empty">从左侧选择或新建一个会话开始聊天</div>

      <div class="msg-box" ref="box">
        <p v-if="loadingMsg" class="box-tip">加载消息…</p>
        <div
          v-for="m in messages" :key="m.id"
          class="msg" :class="msgClass(m)"
        >
          <!-- 撤回占位（v1.18.14，v1.18.33 文案统一）：正文与附件接口层已屏蔽，只渲染灰色斜体提示，时间保留。
               v1.18.33 起他人也可撤回，无法用「你/对方」区分撤回者，统一为中性文案 -->
          <div v-if="m.recalled" class="bubble recalled-bubble">
            <div class="msg-text recalled-text">消息已被撤回</div>
            <div class="msg-time">{{ fmtTime(m.created_at) }}</div>
          </div>
          <template v-else>
            <div class="bubble">
              <!-- v1.18.22：问题引用卡片（消息带 ref 时渲染）：📋 + 问题 #id + 标题 + 状态中文 chip -->
              <div
                v-if="m.ref"
                class="ref-card"
                :class="{ clickable: canViewIssues }"
                @click="onRefClick(m.ref)"
              >
                <span class="ref-ico">📋</span>
                <div class="ref-main">
                  <div class="ref-line">
                    <span class="ref-id">问题 #{{ m.ref.id }}</span>
                    <span class="ref-title">{{ m.ref.title }}</span>
                  </div>
                  <span class="ref-chip" :class="'st-' + m.ref.status">{{ m.ref.status }}</span>
                </div>
              </div>
              <div class="msg-from" v-if="m.sender !== me">{{ m.sender === 'assistant' ? 'AI 助手' : displayName(m.sender) }}</div>
              <div v-if="m.body" class="msg-text">{{ m.body }}</div>
              <div v-if="m.attachments && m.attachments.length" class="msg-atts">
                <template v-for="a in m.attachments" :key="a.id || a.storedName">
                  <img v-if="isImageAtt(a)" class="msg-img" :src="attSrc(a)" alt="图片" @click="previewAtt = a" />
                  <button v-else class="msg-file" @click="downloadAtt(a)" :title="'下载 ' + a.originalName">
                    <span class="f-ico">📄</span>
                    <span class="f-name">{{ a.originalName }}</span>
                    <span class="f-size">{{ fmtSize(a.size) }}</span>
                  </button>
                </template>
              </div>
              <div class="msg-time">{{ fmtTime(m.created_at) }}<span v-if="msgReceipt(m)" class="msg-receipt" :class="msgReceipt(m) === '已读' ? 'read' : 'unread'">{{ msgReceipt(m) }}</span></div>
            </div>
            <!-- 悬浮操作（v1.18.14）：hover 显隐，贴气泡上方；复制仅对有正文的消息开放 -->
            <div class="msg-actions">
              <button v-if="m.body" class="msg-act" title="复制" @click="copyMessage(m)">复制</button>
              <button v-if="canRecall(m)" class="msg-act msg-act-danger" title="撤回" @click="recallMsg(m)">撤回</button>
            </div>
          </template>
        </div>
      </div>

      <footer class="chat-input" v-if="activeConv">
        <div v-if="pending.length" class="att-pending">
          <div v-for="(a, i) in pending" :key="a.id || a.storedName" class="att-chip">
            <img v-if="isImageAtt(a)" :src="attSrc(a)" alt="" />
            <span v-else class="att-chip-ico">📄</span>
            <span class="att-chip-name" :title="a.originalName">{{ a.originalName }}</span>
            <button class="att-chip-del" title="移除" @click="removePending(i)">✕</button>
          </div>
        </div>
        <div class="chat-input-row">
          <button class="clip" :disabled="!canUse || uploading" title="上传图片/文件（也可直接粘贴或拖入）" @click="pickFiles">📎</button>
          <input ref="fileInput" type="file" multiple class="hidden-file" @change="onFilePicked" />
          <textarea
            v-model="draft" rows="2" :disabled="!canUse"
            :placeholder="canUse ? '输入消息，Enter 发送 / Shift+Enter 换行（支持粘贴图片、文件）' : '无聊天权限'"
            @keydown.enter.exact.prevent="send"
            @paste="onPaste"
          ></textarea>
          <button class="send" :disabled="!canUse || sending || uploading || (!draft.trim() && !pending.length)" @click="send">
            {{ sending ? '发送中…' : (uploading ? '上传中…' : '发送') }}
          </button>
        </div>
        <p v-if="uploading" class="att-tip">附件上传中…</p>
      </footer>
      <p v-if="error" class="chat-error">{{ error }}</p>
    </div>

    <!-- 新建同事会话（按项目约定：点击空白不关闭） -->
    <div v-if="showNew" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>新建会话</h3>
          <button class="icon-btn" @click="showNew = false">✕</button>
        </div>
        <div class="modal-body">
          <label class="nl-label">选择成员（同事）</label>
          <!-- v1.18.29：类型二级 sheet 页（沿用用户管理 v1.18.15 交互）；勾选状态存 username，跨 sheet 保留 -->
          <div class="sub-tabs">
            <Tabs v-model="pickedType" :tabs="memberTabs" />
          </div>
          <div class="user-pick">
            <p v-if="usersLoading" class="box-tip">加载用户…</p>
            <label v-for="u in visibleUsers" :key="u.username" class="pick-row">
              <input type="checkbox" :checked="picked.includes(u.username)" @change="togglePick(u.username)" />
              <span>{{ u.name || u.username }} <i v-if="u.username !== u.name">（{{ u.username }}）</i><i class="u-type" :class="u.userType === 'company' ? 'co' : 'ho'">{{ u.userType === 'company' ? '公司' : '院方' }}</i></span>
            </label>
            <!-- v1.18.29：空态区分——花名册本身为空 vs 该类型下没有成员 -->
            <p v-if="!usersLoading && !users.length" class="box-tip">暂无可添加的同事</p>
            <p v-else-if="!usersLoading && !visibleUsers.length" class="box-tip">该类型下暂无可添加的同事</p>
          </div>
          <label class="nl-label">会话标题（选填，留空则用成员名）</label>
          <input class="nl-input" v-model="newTitle" placeholder="如：3 号楼网络故障" />
        </div>
        <div class="modal-foot">
          <button class="small" @click="showNew = false">取消</button>
          <button class="small primary" :disabled="!picked.length" @click="createNew">创建并打开</button>
        </div>
      </div>
    </div>

    <!-- 图片放大预览（按项目约定：点击空白不关闭，用按钮关闭） -->
    <div v-if="previewAtt" class="img-mask">
      <div class="img-view">
        <img :src="attSrc(previewAtt)" :alt="previewAtt.originalName" />
        <div class="img-bar">
          <span class="img-name">{{ previewAtt.originalName }}</span>
          <button class="small" @click="downloadAtt(previewAtt)">下载</button>
          <button class="small primary" @click="previewAtt = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 轻量 toast（v1.18.14）：复制/撤回/移除的即时反馈 -->
    <transition name="chat-toast-fade">
      <div v-if="toast.show" class="chat-toast" :class="'chat-toast-' + toast.kind" role="status">{{ toast.text }}</div>
    </transition>
  </section>
</template>

<style scoped>
/* v1.18.35：聊天视图撑满内容区。
   根因：.content 是列向 flex，`.content > section` 的 auto margin 会让子项放弃
   stretch、宽度收缩为 fit-content——聊天内容窄，整卡缩成中间一条。故必须显式
   width:100%（再被 max-width:1360 截断居中）；高度改由 flex:1 撑满 .content
   剩余空间（v1.18.34 起内容区固定高度内部滚动），输入框自然贴到页脚上方，
   替换旧整窗滚动时代的 height:calc(100vh - 120px) 硬编码。 */
.chat { display: flex; width: 100%; flex: 1 1 auto; min-height: 0; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.chat-side { width: 290px; flex: none; border-right: 1px solid var(--border); display: flex; flex-direction: column; background: var(--panel-2); }
.side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); }
.seg { display: flex; gap: 2px; background: #eef2f7; border-radius: 8px; padding: 2px; }
.seg button { border: 0; background: transparent; padding: 5px 9px; font-size: 12.5px; border-radius: 6px; color: var(--muted); cursor: pointer; }
.seg button.on { background: #fff; color: var(--primary); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.new-btn { flex: none; border: 1px solid var(--primary); color: var(--primary); background: #fff; border-radius: 8px; padding: 5px 10px; font-size: 12.5px; cursor: pointer; }
.ai-entry { display: flex; align-items: center; gap: 8px; margin: 10px 12px 4px; padding: 10px 12px; border: 1px dashed var(--primary); color: var(--primary); border-radius: 10px; background: #f5f9ff; cursor: pointer; font-weight: 600; font-size: 13.5px; }
.ai-ico { font-size: 16px; }
.conv-list { flex: 1; overflow-y: auto; padding: 6px 8px 12px; }
.side-tip { color: var(--muted); font-size: 13px; text-align: center; padding: 20px 0; }
.conv-item { display: flex; gap: 10px; width: 100%; text-align: left; border: 0; background: transparent; padding: 9px 8px; border-radius: 10px; cursor: pointer; align-items: center; position: relative; font: inherit; }
.conv-item:hover { background: #eef2f7; }
.conv-item.active { background: #e7f0ff; }
.conv-ava { width: 38px; height: 38px; flex: none; border-radius: 10px; background: var(--primary); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; }
.conv-ava.ai { background: #6d28d9; }
.conv-meta { flex: 1; min-width: 0; }
.conv-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.conv-name-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
.conv-name { font-size: 13.5px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
/* v1.18.37：会话已读/未读状态标识（与项目状态 pill 同风格：红=未读，灰=已读、无底色不抢视线） */
.conv-status { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; white-space: nowrap; }
.conv-status.read { color: var(--muted); background: transparent; }
.conv-status.unread { color: #dc2626; background: #fee2e2; font-weight: 600; }
.conv-status .dot { width: 6px; height: 6px; border-radius: 50%; background: #dc2626; }
.conv-badge { flex: none; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #dc2626; color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center; }
.conv-last { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }

.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.chat-main-head { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.chat-main-head h3 { margin: 0; font-size: 15px; }
.chat-main-head .sub { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.chat-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 13.5px; }
.msg-box { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; background: #f7f9fc; }
.box-tip { color: var(--muted); font-size: 12.5px; text-align: center; }
.msg { display: flex; position: relative; }
.msg.me { justify-content: flex-end; }
.msg.other, .msg.ai { justify-content: flex-start; }
.bubble { max-width: 72%; padding: 9px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.55; }
.msg.me .bubble { background: var(--primary); color: #fff; border-bottom-right-radius: 3px; }
.msg.other .bubble { background: #fff; border: 1px solid var(--border); border-bottom-left-radius: 3px; }
.msg.ai .bubble { background: #f3e8ff; border: 1px solid #e9d5ff; color: #4c1d95; border-bottom-left-radius: 3px; }
.msg-from { font-size: 11.5px; color: var(--muted); margin-bottom: 3px; }
.msg.me .msg-from { display: none; }
.msg-time { font-size: 10.5px; opacity: .6; margin-top: 4px; text-align: right; }
/* ===== v1.18.39：自己消息的已读/未读回执（时间旁小字；蓝底气泡内——未读浅红、已读半透明白，语义与会话列表 conv-status 一致） ===== */
.msg-receipt { margin-left: 6px; font-weight: 600; }
.msg-receipt.read { color: rgba(255,255,255,.85); }
.msg-receipt.unread { color: #fda4a4; }
.chat-input { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); background: var(--panel); }
.chat-input-row { display: flex; gap: 8px; align-items: flex-end; }
.chat-input textarea { flex: 1; resize: none; border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; font-size: 13.5px; font-family: inherit; }
.chat-input .send { flex: none; align-self: flex-end; padding: 9px 18px; }
.hidden-file { display: none; }
.clip { flex: none; align-self: flex-end; width: 38px; height: 38px; border: 1px solid var(--border); background: #fff; border-radius: 10px; font-size: 17px; line-height: 1; cursor: pointer; }
.clip:disabled { opacity: .5; cursor: not-allowed; }
.att-tip { margin: 0; font-size: 12px; color: var(--muted); }

/* 待发送附件预览 */
.att-pending { display: flex; flex-wrap: wrap; gap: 8px; }
.att-chip { display: flex; align-items: center; gap: 6px; max-width: 220px; border: 1px solid var(--border); background: var(--panel-2); border-radius: 8px; padding: 4px 6px; }
.att-chip img { width: 30px; height: 30px; object-fit: cover; border-radius: 6px; }
.att-chip-ico { font-size: 18px; }
.att-chip-name { font-size: 12.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.att-chip-del { flex: none; border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; }
.att-chip-del:hover { color: #b91c1c; }

/* 消息内附件 */
.msg-atts { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.msg-img { max-width: 220px; max-height: 220px; border-radius: 10px; cursor: zoom-in; display: block; }
.msg-file { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); background: #fff; border-radius: 10px; padding: 8px 10px; cursor: pointer; text-align: left; max-width: 260px; }
.msg-file .f-ico { font-size: 18px; }
.msg-file .f-name { font-size: 12.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.msg-file .f-size { flex: none; font-size: 11.5px; color: var(--muted); }
.msg.me .msg-file { background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.4); }
.msg.me .msg-file .f-name { color: #fff; }
.msg.me .msg-file .f-size { color: rgba(255,255,255,.78); }
.chat-error { color: #b91c1c; font-size: 12.5px; padding: 0 16px 10px; margin: 0; }

/* ===== v1.18.22：聊天气泡内的「问题引用」卡片 ===== */
.ref-card {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 9px 11px; border-radius: 10px; margin-bottom: 7px;
  background: rgba(15, 23, 42, .04); border: 1px solid var(--border-strong);
}
/* 可点击态（有 issues 权限）：高亮可点；无权限时不可点、cursor 默认（继承，不加 pointer） */
.ref-card.clickable { cursor: pointer; transition: background .12s, border-color .12s; }
.ref-card.clickable:hover { background: #eef4ff; border-color: var(--primary); }
.ref-ico { font-size: 16px; line-height: 1.5; flex: none; }
.ref-main { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.ref-line { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.ref-id { font-size: 11.5px; color: var(--muted); letter-spacing: .03em; flex: none; }
.ref-title { font-size: 13px; font-weight: 600; color: var(--text); word-break: break-word; }
/* 状态中文 chip（沿用项目状态语义色：待处理=黄 / 处理中=蓝 / 已解决=绿 / 已关闭=灰；
   项目既有 .st-* 无全局配色，此处自包含实现一致的语义色） */
.ref-chip { align-self: flex-start; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.ref-chip.st-待处理 { background: #fef3c7; color: #b45309; }
.ref-chip.st-处理中 { background: #e0edff; color: #1d4ed8; }
.ref-chip.st-已解决 { background: #dcfce7; color: #15803d; }
.ref-chip.st-已关闭 { background: #eef2f7; color: #64748b; }

/* 图片放大预览（点击空白不关闭，用按钮关闭） */
.img-mask { position: fixed; inset: 0; z-index: 130; background: rgba(15,23,42,.72); display: flex; align-items: center; justify-content: center; padding: 28px; }
.img-view { max-width: 92vw; max-height: 92vh; display: flex; flex-direction: column; gap: 10px; }
.img-view img { max-width: 92vw; max-height: 82vh; object-fit: contain; border-radius: 10px; background: #0b1220; }
.img-bar { display: flex; align-items: center; justify-content: flex-end; gap: 10px; color: #fff; }
.img-name { margin-right: auto; font-size: 13px; opacity: .92; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.modal-mask { position: fixed; inset: 0; z-index: 120; background: rgba(15,23,42,.5); display: flex; align-items: center; justify-content: center; padding: 20px; }
.modal { background: var(--panel); border-radius: var(--radius); width: min(440px, 94vw); box-shadow: var(--shadow-lg); }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.modal-head h3 { margin: 0; font-size: 15px; }
.modal-body { padding: 14px 16px; max-height: 60vh; overflow-y: auto; }
.nl-label { display: block; font-size: 12.5px; color: var(--muted); margin: 6px 0 6px; }
.user-pick { border: 1px solid var(--border); border-radius: 10px; padding: 6px; max-height: 220px; overflow-y: auto; }
.pick-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; font-size: 13px; cursor: pointer; }
.pick-row:hover { background: #eef2f7; }
.pick-row i { color: var(--muted); font-style: normal; font-size: 11.5px; }
/* ===== v1.18.29：新建会话选成员的类型二级 sheet 页 + 行内类型小标记 ===== */
/* 紧凑变体与 UserManage 的 .sub-tabs 三行一致，体现二级层级 */
.sub-tabs { margin: -4px 0 2px; }
.sub-tabs :deep(.tabs) { margin: 0 0 12px; }
.sub-tabs :deep(.tab) { padding: 6px 11px; font-size: 12.5px; }
/* 类型小标记：写全 `.pick-row .u-type` 以覆盖 `.pick-row i` 的默认字号/颜色；行高基本不变 */
.pick-row .u-type { margin-left: 5px; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 15px; vertical-align: 1px; }
.pick-row .u-type.co { background: #eef4ff; color: #1d4ed8; border: 1px solid #c3d7fb; }
.pick-row .u-type.ho { color: var(--muted); }
.nl-input { width: 100%; border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; font-size: 13.5px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }

/* ===== v1.18.14：撤回 / 复制 / 移除会话 ===== */
/* 撤回占位气泡：灰底虚线框 + 斜体（须写在 .msg.me/.other/.ai .bubble 之后以覆盖配色） */
.msg .recalled-bubble, .msg.me .recalled-bubble, .msg.other .recalled-bubble, .msg.ai .recalled-bubble {
  background: #f1f5f9; color: var(--muted); border: 1px dashed var(--border); border-radius: 12px;
}
.recalled-text { color: var(--muted); font-style: italic; font-size: 12.5px; }
/* 悬浮操作：hover 显隐，贴气泡上方；me 靠右，other/ai 靠左 */
.msg-actions { position: absolute; top: -20px; display: flex; gap: 4px; opacity: 0; pointer-events: none; transition: opacity .12s; }
.msg:hover .msg-actions { opacity: 1; pointer-events: auto; }
.msg.me .msg-actions { right: 4px; }
.msg.other .msg-actions, .msg.ai .msg-actions { left: 4px; }
.msg-act { border: 1px solid var(--border); background: #fff; color: var(--muted); font-size: 11px; line-height: 1; padding: 4px 9px; border-radius: 8px; cursor: pointer; box-shadow: 0 1px 3px rgba(15,23,42,.14); }
.msg-act:hover { color: var(--primary); border-color: var(--primary); }
.msg-act-danger:hover { color: #b91c1c; border-color: #b91c1c; }
/* 会话列表移除按钮：hover 显隐，贴条目右侧垂直居中 */
.conv-remove { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); opacity: 0; border: 0; background: transparent; color: var(--muted); font-size: 12px; line-height: 1; padding: 5px 6px; border-radius: 6px; cursor: pointer; transition: opacity .12s; }
.conv-item:hover .conv-remove { opacity: 1; }
.conv-remove:hover { color: #b91c1c; background: rgba(15,23,42,.06); }
/* 轻量 toast：居中底部，2.5s 自动消失 */
.chat-toast { position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%); z-index: 200; background: #0f172a; color: #fff; font-size: 13px; padding: 9px 16px; border-radius: 10px; box-shadow: var(--shadow-lg); }
.chat-toast-error { background: #b91c1c; }
.chat-toast-fade-enter-active, .chat-toast-fade-leave-active { transition: opacity .2s; }
.chat-toast-fade-enter-from, .chat-toast-fade-leave-to { opacity: 0; }
</style>
