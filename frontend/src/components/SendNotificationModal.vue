<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

// 发送通知弹框：铃铛面板与消息页共用（父组件用 v-if 控制挂载）。
const props = defineProps({
  canSend: { type: Boolean, default: false },
  canBroadcast: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'sent']);

const sendError = ref('');
const sending = ref(false);
const users = ref([]);
const usersLoaded = ref(false);
const target = ref(props.canBroadcast ? 'all' : 'single');   // 'all' | 'single'
const picked = ref([]);
const sform = ref({ title: '', body: '' });

async function loadUsers() {
  try {
    users.value = await api.listUsersLookup();
    usersLoaded.value = true;
  } catch (e) {
    sendError.value = e.message || '加载用户失败';
  }
}
function togglePick(username) {
  const set = new Set(picked.value);
  if (set.has(username)) set.delete(username); else set.add(username);
  picked.value = [...set];
}
function pickAll() { picked.value = users.value.map((u) => u.username); }
function clearPick() { picked.value = []; }

async function submitSend() {
  sendError.value = '';
  const title = (sform.value.title || '').trim();
  const body = (sform.value.body || '').trim();
  if (!title) { sendError.value = '标题必填'; return; }
  if (target.value === 'single' && picked.value.length === 0) { sendError.value = '请至少选择 1 位接收人'; return; }
  sending.value = true;
  try {
    if (target.value === 'all') {
      await api.broadcastNotification({ title, body });
    } else {
      await api.sendNotification({ title, body, to: picked.value });
    }
    emit('sent');
    emit('close');
  } catch (e) {
    sendError.value = e.message || '发送失败';   // 错误显示在弹框内，不弹 alert
  } finally {
    sending.value = false;
  }
}

onMounted(() => {
  if (props.canSend) loadUsers();   // 需要指定用户时才拉列表
});
</script>

<template>
  <div class="modal-mask send-mask">
    <div class="modal narrow">
      <h3>发送通知</h3>
      <label v-if="canBroadcast || canSend" class="full">接收对象
        <div class="send-radios">
          <label v-if="canBroadcast" class="send-radio"><input type="radio" value="all" v-model="target" /> 全员</label>
          <label v-if="canSend" class="send-radio"><input type="radio" value="single" v-model="target" /> 指定用户</label>
        </div>
      </label>

      <template v-if="target === 'single' && canSend">
        <div class="send-pick-head">
          <span>选择接收人（至少 1 人）</span>
          <span class="send-pick-ops">
            <button class="small" type="button" @click="pickAll">全部选中</button>
            <button class="small" type="button" @click="clearPick">清空</button>
          </span>
        </div>
        <div class="send-users">
          <label v-for="u in users" :key="u.username" class="send-user">
            <input type="checkbox" :checked="picked.includes(u.username)" @change="togglePick(u.username)" />
            <span>{{ u.name }}<em>{{ u.username }}</em></span>
          </label>
          <p v-if="users.length === 0" class="send-users-empty">暂无可选用户</p>
        </div>
      </template>

      <label class="full">标题*<input v-model="sform.title" maxlength="200" placeholder="通知标题（200 字以内）" /></label>
      <label class="full">内容*<textarea v-model="sform.body" rows="4" maxlength="2000" placeholder="通知内容（2000 字以内）"></textarea></label>
      <p v-if="sendError" class="err">{{ sendError }}</p>
      <div class="modal-actions">
        <button class="primary" :disabled="sending" @click="submitSend">{{ sending ? '发送中…' : '发送' }}</button>
        <button :disabled="sending" @click="emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 发送通知弹框：置于铃铛面板（z-index 61）之上，避免被遮挡 */
.send-mask { z-index: 70; }
.send-radios { display: flex; gap: 18px; flex-direction: row; }
.send-radio { display: flex; flex-direction: row; align-items: center; gap: 5px; font-size: 13px; color: var(--text); }
.send-radio input { width: auto; }
.send-pick-head { display: flex; align-items: center; justify-content: space-between; margin: 10px 0 6px; font-size: 12px; color: var(--muted); }
.send-pick-ops { display: flex; gap: 6px; }
.send-users {
  max-height: 150px; overflow: auto; border: 1px solid var(--border-strong);
  border-radius: 9px; padding: 6px 8px; background: #fbfcfe;
}
.send-user { display: flex; flex-direction: row; align-items: center; gap: 7px; padding: 4px 2px; font-size: 13px; color: var(--text); cursor: pointer; }
.send-user input { width: auto; }
.send-user em { font-style: normal; color: var(--muted); font-size: 11.5px; margin-left: 6px; }
.send-users-empty { margin: 6px 2px; font-size: 12.5px; color: var(--muted); }
</style>
