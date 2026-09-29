<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['close']);
const oldPassword = ref('');
const newPassword = ref('');
const newPassword2 = ref('');
const error = ref('');
const ok = ref(false);
const loading = ref(false);

async function submit() {
  error.value = '';
  ok.value = false;
  if (!oldPassword.value || !newPassword.value) { error.value = '请填写原密码和新密码'; return; }
  if (newPassword.value.length < 6) { error.value = '新密码至少 6 位'; return; }
  if (newPassword.value !== newPassword2.value) { error.value = '两次输入的新密码不一致'; return; }
  loading.value = true;
  try {
    await api.changePassword(oldPassword.value, newPassword.value);
    ok.value = true;
    oldPassword.value = newPassword.value = newPassword2.value = '';
  } catch (e) {
    error.value = e.message || '修改失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="modal-mask">
    <div class="modal narrow">
      <h3>修改密码</h3>
      <label class="full">原密码<input v-model="oldPassword" type="password" /></label>
      <label class="full">新密码（至少 6 位）<input v-model="newPassword" type="password" /></label>
      <label class="full">确认新密码<input v-model="newPassword2" type="password" /></label>
      <p v-if="error" class="err">{{ error }}</p>
      <p v-if="ok" class="okmsg">密码修改成功</p>
      <div class="modal-actions">
        <button class="primary" :disabled="loading" @click="submit">{{ loading ? '提交中…' : '确定' }}</button>
        <button @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>
