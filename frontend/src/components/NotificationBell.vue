<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { unread, refreshUnread, setUnread, decUnread, clearUnread, fmtTime } from '../notifications.js';
import SendNotificationModal from './SendNotificationModal.vue';

// 右下角浮动铃铛：未读数来自共享状态（导航栏徽标 / 消息页共用）。
defineProps({
  canSend: { type: Boolean, default: false },
  canBroadcast: { type: Boolean, default: false },
});
const emit = defineEmits(['open-center']);

const open = ref(false);
const items = ref([]);
const unreadOnly = ref(false);
const expanded = ref(null);   // 展开全文的消息 id
const showSend = ref(false);

// 本地过滤：全部 / 未读
const shown = computed(() => (unreadOnly.value ? items.value.filter((m) => !m.read) : items.value));

async function loadList() {
  try {
    const r = await api.listNotifications({ limit: 50 });
    items.value = r.rows || [];
    setUnread(r.unread);   // 同步到全局共享未读数
  } catch { /* 加载失败静默处理，不弹错 */ }
}

async function toggleOpen() {
  open.value = !open.value;
  if (open.value) await loadList();
}
function close() { open.value = false; }

async function openItem(m) {
  if (expanded.value === m.id) { expanded.value = null; return; }
  expanded.value = m.id;
  if (!m.read) {
    try {
      await api.markNotificationRead(m.id);
      m.read = true;
      decUnread();
    } catch { /* 静默 */ }
  }
}
async function markAll() {
  if (!unread.value) return;
  try {
    await api.markAllNotificationsRead();
    items.value.forEach((m) => { m.read = true; });
    clearUnread();
  } catch { /* 静默 */ }
}

// 打开「发送通知」弹框：先收起铃铛面板，避免遮挡
function openSend() {
  open.value = false;
  showSend.value = true;
}
// 发送成功：刷新列表并同步全局未读数
function onSent() {
  loadList();
  refreshUnread();
}
// 跳到独立消息页
function openCenter() {
  open.value = false;
  emit('open-center');
}

onMounted(loadList);
</script>

<template>
  <div class="nbell">
    <!-- 透明遮罩承载面板：点击面板外部不再关闭，请用右上角 × 关闭 -->
    <div v-if="open" class="nbell-mask">
      <div class="nbell-panel">
        <div class="nbell-head">
          <h4>消息通知</h4>
          <div class="nbell-head-ops">
            <button v-if="canSend || canBroadcast" class="small" @click="openSend">发送通知</button>
            <button class="small" :disabled="unread === 0" @click="markAll">全部已读</button>
            <button class="small" @click="openCenter">查看全部</button>
            <button class="nbell-x" title="关闭" @click="close">×</button>
          </div>
        </div>

        <div class="nbell-filters">
          <button class="nbell-tab" :class="{ active: !unreadOnly }" @click="unreadOnly = false">全部</button>
          <button class="nbell-tab" :class="{ active: unreadOnly }" @click="unreadOnly = true">
            未读<span v-if="unread > 0" class="nbell-tab-num">{{ unread }}</span>
          </button>
        </div>

        <div class="nbell-list">
          <div v-for="m in shown" :key="m.id" class="nbell-item" :class="{ unread: !m.read }" @click="openItem(m)">
            <span class="nbell-dot" :class="{ on: !m.read }"></span>
            <div class="nbell-main">
              <div class="nbell-title">{{ m.title }}</div>
              <div v-if="m.body" class="nbell-text" :class="{ clamp: expanded !== m.id }">{{ m.body }}</div>
              <div class="nbell-meta">{{ m.from || '系统' }} · {{ fmtTime(m.created_at) }}</div>
            </div>
          </div>
          <div v-if="shown.length === 0" class="nbell-empty">{{ unreadOnly ? '暂无未读消息' : '暂无消息' }}</div>
        </div>
      </div>
    </div>

    <!-- 浮动铃铛 -->
    <button class="nbell-btn" title="消息通知" @click="toggleOpen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8.5a6 6 0 0 0-12 0c0 6-2.2 7.5-2.2 7.5h16.4S18 14.5 18 8.5z" />
        <path d="M13.7 20a2 2 0 0 1-3.4 0" />
      </svg>
      <span v-if="unread > 0" class="nbell-badge">{{ unread > 99 ? '99+' : unread }}</span>
    </button>

    <!-- 发送通知弹框（独立组件，与消息页共用） -->
    <SendNotificationModal
      v-if="showSend"
      :can-send="canSend"
      :can-broadcast="canBroadcast"
      @close="showSend = false"
      @sent="onSent"
    />
  </div>
</template>

<style scoped>
/* 浮动铃铛 */
.nbell-btn {
  position: fixed; right: 22px; bottom: 22px; z-index: 60;
  width: 48px; height: 48px; padding: 0; border-radius: 50%;
  background: linear-gradient(180deg, #3b74f6, var(--primary));
  border: none; color: #fff;
  box-shadow: 0 8px 22px rgba(37, 99, 235, .42);
}
.nbell-btn:hover { background: linear-gradient(180deg, #2f68ee, var(--primary-d)); }
.nbell-btn svg { width: 22px; height: 22px; display: block; }
/* v1.18.4：与侧栏 .nav-badge 统一视觉（同色微渐变 + 等宽数字 + 定高居中），
   并保留白色描边环，使其压在蓝色圆形按钮上时边缘干净。 */
.nbell-badge {
  position: absolute; top: -3px; right: -3px;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: linear-gradient(180deg, #f87171, #e11d48); color: #fff;
  font-size: 10.5px; font-weight: 650; line-height: 1;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2px #fff, 0 1px 3px rgba(225, 29, 72, .35);
}

/* 透明遮罩 + 面板 */
.nbell-mask { position: fixed; inset: 0; z-index: 60; }
.nbell-panel {
  position: fixed; right: 22px; bottom: 82px; width: 360px; max-height: 70vh; z-index: 61;
  display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 14px; box-shadow: var(--shadow-lg); overflow: hidden;
}
.nbell-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid var(--border); background: var(--panel-2);
}
.nbell-head h4 { margin: 0; font-size: 14px; }
.nbell-head-ops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.nbell-x {
  width: 26px; height: 26px; padding: 0; border: none; background: transparent;
  font-size: 18px; line-height: 1; color: var(--muted); border-radius: 7px;
}
.nbell-x:hover { background: #eef2f7; color: var(--text); }

.nbell-filters { display: flex; gap: 8px; padding: 10px 14px 4px; }
.nbell-tab {
  padding: 3px 12px; border-radius: 999px; font-size: 12px;
  border: 1px solid var(--border-strong); background: #fff; color: var(--muted);
}
.nbell-tab.active { background: #eff6ff; border-color: #bfdbfe; color: var(--primary-d); font-weight: 600; }
.nbell-tab-num {
  display: inline-block; margin-left: 6px; min-width: 16px; padding: 0 5px;
  border-radius: 999px; background: #dc2626; color: #fff; font-size: 10.5px; line-height: 16px; text-align: center;
}

.nbell-list { flex: 1; max-height: 46vh; overflow: auto; padding: 6px 0; }
.nbell-item { display: flex; gap: 9px; padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #f1f5f9; }
.nbell-item:hover { background: #f9fbfe; }
.nbell-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; background: transparent; }
.nbell-dot.on { background: var(--primary); }
.nbell-main { min-width: 0; flex: 1; }
.nbell-title { font-size: 13px; font-weight: 650; color: var(--text); word-break: break-word; }
.nbell-item.unread .nbell-title { color: var(--primary-d); }
.nbell-text { font-size: 12.5px; color: #48566b; line-height: 1.55; margin-top: 3px; word-break: break-word; white-space: pre-wrap; }
.nbell-text.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.nbell-meta { font-size: 11.5px; color: var(--muted); margin-top: 5px; }
.nbell-empty { text-align: center; color: var(--muted); font-size: 12.5px; padding: 34px 0; }
</style>
