import { config } from '../config.js';
import { createDevChatStore } from './devChatStore.js';
import { createMssqlChatStore } from './mssqlChatStore.js';

// 模块级缓存：dev 用 JSON 文件，生产用 SQL Server（与 notifications 一致）。
let store;

export async function getChatStore() {
  if (store) return store;
  store = config.dbDriver === 'dev'
    ? createDevChatStore(config.chatDevPath)
    : createMssqlChatStore(config.mssql);
  return store;
}

export async function listConversations(username, orgId) {
  return (await getChatStore()).listConversations(username, orgId);
}
export async function getOrCreateAiConversation(username, orgId) {
  return (await getChatStore()).getOrCreateAiConversation(username, orgId);
}
export async function createConversation(payload) {
  return (await getChatStore()).createConversation(payload);
}
export async function getConversation(id) {
  return (await getChatStore()).getConversation(id);
}
export async function listMessages(convId, opts) {
  return (await getChatStore()).listMessages(convId, opts);
}
export async function addMessage(payload) {
  return (await getChatStore()).addMessage(payload);
}
export async function markRead(convId, username) {
  return (await getChatStore()).markRead(convId, username);
}
export async function unreadTotal(username, orgId) {
  return (await getChatStore()).unreadTotal(username, orgId);
}
// v1.18.14：撤回 / 删除会话 / 退出会话
export async function getMessage(convId, msgId) {
  return (await getChatStore()).getMessage(convId, msgId);
}
export async function recallMessage(convId, msgId) {
  return (await getChatStore()).recallMessage(convId, msgId);
}
export async function deleteConversation(id) {
  return (await getChatStore()).deleteConversation(id);
}
export async function leaveConversation(id, username) {
  return (await getChatStore()).leaveConversation(id, username);
}
