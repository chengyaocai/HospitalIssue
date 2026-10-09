import { ref } from 'vue';

// 登录失效信号（v1.18.48）：api.js 在收到 401（token 过期 / 被服务端拒绝）且请求曾带 token 时置位，
// App.vue 监听到后自动退回登录界面。用 Vue ref 做跨组件共享的「单例信号」，便于测试与解耦。
export const sessionExpired = ref(false);

export function raiseSessionExpired() { sessionExpired.value = true; }
export function resetSessionExpired() { sessionExpired.value = false; }
