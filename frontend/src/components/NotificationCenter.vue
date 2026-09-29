<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { unread, refreshUnread, setUnread, decUnread, clearUnread, fmtTime } from '../notifications.js';
import Tabs from './Tabs.vue';
import SendNotificationModal from './SendNotificationModal.vue';

// 独立消息页：与右下角铃铛共用全局未读数。
defineProps({
  canSend: { type: Boolean, default: false },
  canBroadcast: { type: Boolean, default: false },
});

const items = ref([]);
const tab = ref('all');        // 'all' | 'unread'
const expanded = ref(null);    // 展开全文的消息 id
const loadError = ref('');
const showSend = ref(false);

const tabs = computed(() => [
  { key: 'all', label: '全部' },
  { key: 'unread', label: unread.value > 0 ? `未读(${unread.value})` : '未读' },
]);
const shown = computed(() => (tab.value === 'unread' ? items.value.filter((m) => !m.read) : items.value));

async function load() {
  loadError.value = '';
  try {
    const r = await api.listNotifications({ limit: 200 });
    items.value = r.rows || [];
    setUnread(r.unread);       // 同步到全局共享未读数
  } catch (e) {
    loadError.value = e.message || '加载失败';
  }
}

// 点击行：切换展开/收起；未读则同时标记已读
async function toggleItem(m) {
  if (expanded.value === m.id) { expanded.value = null; return; }
  expanded.value = m.id;
  if (!m.read) await markRead(m);
}
async function markRead(m) {
  try {
    await api.markNotificationRead(m.id);
    m.read = true;
    decUnread();
  } catch { /* 静默 */ }
}
async function markAll() {
  if (!unread.value) return;
  try {
    await api.markAllNotificationsRead();
    items.value.forEach((m) => { m.read = true; });
    clearUnread();
  } catch { /* 静默 */ }
}

function openSend() { showSend.value = true; }
function onSent() { load(); refreshUnread(); }

onMounted(load);
</script>

<template>
  <section>
    <header class="page-head">
      <div>
        <h1>消息通知</h1>
        <p class="sub">系统通知与个人消息 · 共 {{ items.length }} 条<span v-if="unread > 0"> · 未读 {{ unread }} 条</span></p>
      </div>
      <div class="actions">
        <button v-if="canSend || canBroadcast" class="primary" @click="openSend">+ 发送通知</button>
        <button class="small" :disabled="unread === 0" @click="markAll">全部已读</button>
      </div>
    </header>

    <Tabs :tabs="tabs" v-model="tab" />

    <div class="card ncenter-card">
      <p v-if="loadError" class="err">{{ loadError }}</p>
      <div v-else-if="shown.length === 0" class="empty">
        <div class="empty-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8.5a6 6 0 0 0-12 0c0 6-2.2 7.5-2.2 7.5h16.4S18 14.5 18 8.5z" />
            <path d="M13.7 20a2 2 0 0 1-3.4 0" />
          </svg>
        </div>
        <p class="empty-title">{{ tab === 'unread' ? '暂无未读消息' : '暂无消息' }}</p>
        <p class="empty-hint">{{ tab === 'unread' ? '所有消息都已读完了' : '有新的系统通知时会显示在这里' }}</p>
      </div>
      <div v-else class="ncenter-list">
        <div
          v-for="m in shown"
          :key="m.id"
          class="ncenter-item"
          :class="{ unread: !m.read }"
          @click="toggleItem(m)"
        >
          <span class="ncenter-dot" :class="{ on: !m.read }"></span>
          <div class="ncenter-main">
            <div class="ncenter-title">{{ m.title }}</div>
            <div v-if="m.body" class="ncenter-text" :class="{ clamp: expanded !== m.id }">{{ m.body }}</div>
            <div class="ncenter-bottom">
              <span class="ncenter-meta">{{ m.from || '系统' }} · {{ fmtTime(m.created_at) }}</span>
              <button v-if="!m.read" class="small" @click.stop="markRead(m)">标记已读</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <SendNotificationModal
      v-if="showSend"
      :can-send="canSend"
      :can-broadcast="canBroadcast"
      @close="showSend = false"
      @sent="onSent"
    />
  </section>
</template>

<style scoped>
.ncenter-card { padding: 6px 22px; }
.ncenter-list { display: flex; flex-direction: column; }
.ncenter-item {
  display: flex; gap: 10px; padding: 14px 0; cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.ncenter-item:last-child { border-bottom: none; }
.ncenter-item:hover { background: #f9fbfe; }
.ncenter-item.unread { background: #f5f9ff; }
.ncenter-item.unread:hover { background: #eef5ff; }
.ncenter-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; flex-shrink: 0; background: transparent; }
.ncenter-dot.on { background: var(--primary); }
.ncenter-main { min-width: 0; flex: 1; }
.ncenter-title { font-size: 13.5px; font-weight: 600; color: var(--text); word-break: break-word; }
.ncenter-item.unread .ncenter-title { color: var(--primary-d); font-weight: 700; }
.ncenter-text { font-size: 13px; color: #48566b; line-height: 1.6; margin-top: 4px; word-break: break-word; white-space: pre-wrap; }
.ncenter-text.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ncenter-bottom { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 7px; }
.ncenter-meta { font-size: 12px; color: var(--muted); }
</style>
