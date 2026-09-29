<script setup>
import { ref } from 'vue';
import { api } from '../api.js';
import { APP_VERSION } from '../version.js';

const props = defineProps({ appName: String });
const emit = defineEmits(['loggedIn']);
const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  if (!username.value || !password.value) { error.value = '请输入用户名和密码'; return; }
  loading.value = true;
  try {
    const { token, user, org, orgs } = await api.login(username.value, password.value);
    emit('loggedIn', { token, user, org, orgs });
  } catch (e) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-mask">
    <div class="login-card">
      <h2>{{ appName || '医院信息科 · 软件问题登记' }}</h2>
      <p class="sub">请登录后使用</p>
      <label>用户名<input v-model="username" @keyup.enter="submit" autofocus /></label>
      <label>密码<input v-model="password" type="password" @keyup.enter="submit" /></label>
      <p v-if="error" class="err">{{ error }}</p>
      <button class="primary" :disabled="loading" @click="submit">{{ loading ? '登录中…' : '登录' }}</button>
    </div>
    <!-- v1.18.34：登录页底部版权信息 + 版本号 -->
    <div class="login-foot">© 2026 软件问题登记系统 · 版权所有　{{ APP_VERSION }}</div>
  </div>
</template>
