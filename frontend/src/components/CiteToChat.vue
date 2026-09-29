<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

// v1.18.22：把「问题登记列表」里的问题引用到聊天会话发给同事。
// 会话列表用现有 api.listConversations 接口，并排除 type==='ai' 的 AI 会话；
// 选中会话（高亮）后点「发送」：body 传可选留言（≤500 字），ref 只传 { id }，
// 快照 title/status 由后端从问题库读取，不接收客户端伪造值。
// v1.18.24：会话显示名复用 Chat.vue 的姓名逻辑（自定义标题优先，否则显示除自己外的成员姓名）；
//           发送成功后回读最后一条消息校验 ref 是否真的落库——旧后端会静默忽略 ref 字段，
//           把这种静默失败显式化，提示用户更新后端补丁包。
const props = defineProps({
  problem: { type: Object, default: null },
  // 当前登录用户（与 Chat.vue 同源的 App.currentUser），用于「除自己外成员」的显示名与回读校验
  currentUser: { type: Object, default: null },
});
const emit = defineEmits(['close', 'sent']);

const me = computed(() => props.currentUser?.username || '');
const meName = computed(() => props.currentUser?.name || me.value);

const conversations = ref([]);
const nameMap = ref({});   // username -> 姓名（会话显示名用，与 Chat.vue loadNames 同源）
const loading = ref(false);
const keyword = ref('');
const selectedId = ref(null);
const note = ref('');
const sending = ref(false);
const error = ref('');

// 显示用姓名：优先中文姓名，取不到时回退用户名（与 Chat.vue displayName 一致）
function displayName(username) { return nameMap.value[username] || username || ''; }

// 会话展示名（与 Chat.vue convTitle 同逻辑）：自定义标题优先；
// 「成员用户名拼接」视为自动标题，改渲染除自己外的成员姓名。
function convTitle(c) {
  const members = c.members || [];
  const peers = members.filter((m) => m !== me.value);
  const isAuto = !c.title || c.title === members.join('、');
  if (c.title && !isAuto) return c.title;
  const list = peers.length ? peers : members;
  return list.map(displayName).join('、') || meName.value || me.value;
}

// 仅同事会话（排除 AI 助手会话）；按会话名 / 显示名（任一成员姓名）搜索过滤
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return (conversations.value || []).filter((c) => {
    if (c.type === 'ai') return false;
    if (!kw) return true;
    const members = c.members || [];
    const hay = [c.title || '', convTitle(c), ...members.map(displayName), ...members]
      .join(' ')
      .toLowerCase();
    return hay.includes(kw);
  });
});
// 是否存在任何可发送的同事会话（用于空状态提示）
const hasUserConvs = computed(() => (conversations.value || []).some((c) => c.type !== 'ai'));

onMounted(loadConvs);

// 载入「用户名 -> 姓名」映射（取不到则回退用户名显示，与 Chat.vue loadNames 一致）
async function loadNames() {
  try {
    const list = await api.listUsersLookup();
    const m = {};
    for (const u of (list || [])) m[u.username] = u.name || u.username;
    nameMap.value = m;
  } catch { /* 静默：回退用户名 */ }
}

async function loadConvs() {
  loading.value = true;
  error.value = '';
  try {
    await loadNames();
    const list = await api.listConversations();
    conversations.value = Array.isArray(list) ? list : [];
    const userConvs = filtered.value;
    selectedId.value = userConvs.length ? userConvs[0].id : null;
  } catch (e) {
    error.value = e.message || '加载会话失败';
  } finally {
    loading.value = false;
  }
}

// v1.18.24：发送成功后回读校验 —— 查最近 5 条消息，找自己发的最后一条，
// 校验其 ref.id 是否等于被引用的问题 id。旧后端（未随 v1.18.22 更新）会静默丢弃 ref，
// 消息只存文字，回读即能发现。消息刚写入可能有可见性延迟，最多重试 2 次（间隔 400ms）。
const VERIFY_RETRIES = 2;
const VERIFY_DELAY_MS = 400;
async function verifyRefDelivered(problemId) {
  const pid = String(problemId);
  for (let attempt = 0; attempt <= VERIFY_RETRIES; attempt += 1) {
    try {
      const msgs = await api.listMessages(selectedId.value, { limit: 5 });
      const mine = (Array.isArray(msgs) ? msgs : []).filter((m) => m.sender === me.value);
      const last = mine[mine.length - 1];
      if (last && last.ref && String(last.ref.id) === pid) return true;
    } catch { /* 回读失败按未命中处理，走重试 */ }
    if (attempt < VERIFY_RETRIES) await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
  }
  return false;
}

async function send() {
  if (!props.problem || props.problem.id == null) {
    error.value = '引用的问题无效';
    return;
  }
  if (!selectedId.value) {
    error.value = '请选择一个会话';
    return;
  }
  if (note.value.length > 500) {
    error.value = '补充留言过长（≤500 字）';
    return;
  }
  sending.value = true;
  error.value = '';
  try {
    await api.sendChatMessageWithRef(selectedId.value, note.value.trim(), { id: props.problem.id });
    const ok = await verifyRefDelivered(props.problem.id);
    if (ok) {
      showToast('已引用到聊天');
      // 让 toast 短暂可见后再关闭弹框
      setTimeout(() => emit('sent'), 1200);
    } else {
      // 校验失败：不关闭弹框，显式告知是后端版本旧导致的静默失败；发送按钮随 sending 复位恢复可用
      const tip = '后端服务版本较旧，引用未生效。请更新后端补丁包并重启服务后再试';
      showToast(tip, 'error');
      error.value = tip;
    }
  } catch (e) {
    error.value = e.message || '发送失败';
  } finally {
    sending.value = false;
  }
}

// 轻量 toast（与 DutyRoster / Chat 同款交互）：2.5s 自动消失
const toast = ref({ show: false, text: '', kind: 'success' });
let toastTimer = null;
function showToast(text, kind = 'success') {
  toast.value = { show: true, text, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 2500);
}
</script>

<template>
  <div class="modal-mask">
    <div class="modal cite-modal">
      <div class="modal-head">
        <h3>引用到聊天</h3>
        <button class="icon-btn" title="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <!-- 被引用的问题（只读展示） -->
        <div class="cite-problem">
          <span class="cite-problem-ico">📋</span>
          <div class="cite-problem-meta">
            <span class="cite-problem-id">问题 #{{ problem && problem.id }}</span>
            <span class="cite-problem-title">{{ problem && problem.title }}</span>
          </div>
        </div>

        <label class="cite-label">选择会话</label>
        <input class="cite-search" v-model="keyword" placeholder="搜索会话名" />
        <div class="cite-conv-list">
          <p v-if="loading" class="box-tip">加载中…</p>
          <p v-else-if="!hasUserConvs" class="cite-empty">暂无可发送的聊天会话，先去聊天页发起会话</p>
          <p v-else-if="!filtered.length" class="cite-empty">无匹配的会话</p>
          <template v-else>
            <div
              v-for="c in filtered" :key="c.id"
              class="cite-conv" :class="{ active: c.id === selectedId }"
              @click="selectedId = c.id"
            >
              <span class="cite-conv-name">{{ convTitle(c) }}</span>
            </div>
          </template>
        </div>

        <label class="cite-label">补充一句话（可选）</label>
        <textarea
          v-model="note" rows="3" maxlength="500"
          placeholder="补充一句话（可选）"
        ></textarea>
        <p v-if="error" class="cite-error">{{ error }}</p>
      </div>

      <div class="modal-foot">
        <button class="small" @click="emit('close')">取消</button>
        <button class="small primary" :disabled="!selectedId || sending || !hasUserConvs" @click="send">
          {{ sending ? '发送中…' : '发送' }}
        </button>
      </div>
    </div>

    <!-- 轻量 toast（v1.18.22）：发送成功即时反馈 -->
    <transition name="cite-toast-fade">
      <div v-if="toast.show" class="cite-toast" :class="'cite-toast-' + toast.kind" role="status">{{ toast.text }}</div>
    </transition>
  </div>
</template>

<style scoped>
.cite-modal { width: 460px; }
.cite-problem {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--panel-2); margin-bottom: 16px;
}
.cite-problem-ico { font-size: 18px; line-height: 1.4; flex: none; }
.cite-problem-meta { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cite-problem-id { font-size: 12px; color: var(--muted); letter-spacing: .04em; }
.cite-problem-title { font-size: 13.5px; font-weight: 600; color: var(--text); word-break: break-word; }

.cite-label { display: block; font-size: 12.5px; color: var(--muted); margin: 4px 0 6px; }
.cite-search {
  width: 100%; border: 1px solid var(--border-strong); border-radius: 9px;
  padding: 8px 11px; font-size: 13px; color: var(--text); background: #fbfcfe;
}
.cite-conv-list {
  margin-top: 8px; max-height: 200px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: 10px; padding: 6px;
}
.cite-empty { color: var(--muted); font-size: 12.5px; padding: 16px 8px; text-align: center; margin: 0; }
.cite-conv {
  padding: 9px 11px; border-radius: 8px; cursor: pointer; font-size: 13.5px;
  color: var(--text); border: 1px solid transparent;
}
.cite-conv:hover { background: #eef2f7; }
.cite-conv.active { background: #e7f0ff; border-color: var(--primary); color: var(--primary-d); font-weight: 600; }
.cite-conv-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }

.cite-error { margin: 8px 0 0; color: var(--danger); font-size: 12.5px; }

.cite-toast {
  position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%); z-index: 200;
  background: #0f172a; color: #fff; font-size: 13px; padding: 9px 16px; border-radius: 10px;
  box-shadow: var(--shadow-lg);
}
.cite-toast-error { background: #b91c1c; }
.cite-toast-fade-enter-active, .cite-toast-fade-leave-active { transition: opacity .2s; }
.cite-toast-fade-enter-from, .cite-toast-fade-leave-to { opacity: 0; }
</style>
