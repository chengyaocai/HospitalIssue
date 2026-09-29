export const TYPES = ['故障', '需求', '咨询', '其他'];
export const SEVERITIES = ['低', '中', '高', '紧急'];
export const STATUSES = ['待处理', '处理中', '已解决', '已关闭'];
export const SATISFACTIONS = ['满意', '一般', '不满意'];

// 导出可选字段（key 必须与后端 export.js 的 EXPORT_COLUMNS 一致；always=true 为必导出列）
export const EXPORT_FIELDS = [
  { key: 'id', label: 'ID', always: true },
  { key: 'title', label: '问题标题', always: true },
  { key: 'department', label: '所属科室' },
  { key: 'reporter', label: '提出人' },
  { key: 'contact', label: '联系方式' },
  { key: 'type', label: '问题类型' },
  { key: 'severity', label: '严重程度' },
  { key: 'status', label: '状态', always: true },
  { key: 'satisfaction', label: '满意度' },
  { key: 'feedback', label: '回访备注' },
  { key: 'description', label: '问题描述' },
  { key: 'handler', label: '处理人' },
  { key: 'registrar', label: '登记人' },
  { key: 'softwareSystem', label: '软件系统' },
  { key: 'resolution', label: '处理说明' },
  { key: 'created_at', label: '登记时间' },
  { key: 'updated_at', label: '更新时间' },
  { key: 'resolved_at', label: '解决时间' },
  // 审核 4 列（v1.2，key 与后端 export.js 一致）
  { key: 'audit_status', label: '审核状态' },
  { key: 'audit_reason', label: '审核意见' },
  { key: 'audit_by', label: '审核人' },
  { key: 'audit_at', label: '审核时间' },
];

// 审核状态枚举与语义色（供列表/详情/审核视图共用）
export const AUDIT_STATUSES = ['待审核', '已通过', '不通过'];

// 操作日志「操作」列中文名（与后端 export.js 的 ACTION_LABELS 保持一致；未知 action 原样输出）
export const ACTION_LABELS = {
  LOGIN: '登录',
  CHANGE_PASSWORD: '修改密码',
  CREATE_ISSUE: '登记问题',
  UPDATE_ISSUE: '编辑问题',
  DELETE_ISSUE: '删除问题',
  RESTORE_ISSUE: '回收站恢复',
  PURGE_ISSUE: '彻底删除问题',
  APPROVE_ISSUE: '审核通过',
  REJECT_ISSUE: '审核不通过',
  BULK_UPDATE_STATUS: '批量改状态',
  BULK_DELETE_ISSUE: '批量删除问题',
  RATE_SATISFACTION: '回访打分',
  UPLOAD_ATTACHMENT: '上传附件',
  DELETE_ATTACHMENT: '删除附件',
  CREATE_USER: '新增用户',
  UPDATE_USER_ROLE: '修改用户角色',
  RESET_PASSWORD: '重置密码',
  UPDATE_SETTINGS: '修改系统设置',
  SEND_NOTIFICATION: '发送通知',
  BROADCAST_NOTIFICATION: '发送全员通知',
  CREATE_SCHEDULE: '新增排班',
  UPDATE_SCHEDULE: '修改排班',
  DELETE_SCHEDULE: '删除排班',
  COPY_SCHEDULE: '复制排班',
  SYNC_SCHEDULE: '跨机构同步排班',
  CREATE_CHAT: '新建会话',
  UPLOAD_CHAT_ATTACHMENT: '上传聊天附件',
  ENABLE_USER: '启用用户',
  DISABLE_USER: '停用用户',
  // 多机构（v1.18）
  CREATE_ORG: '新建机构',
  UPDATE_ORG: '修改机构',
  DELETE_ORG: '删除机构',
  UPDATE_ORG_MEMBER: '设置机构成员',
  REMOVE_ORG_MEMBER: '移出机构成员',
  SWITCH_ORG: '切换机构',
  GRANT_PLATFORM_ADMIN: '设为平台管理员',
  REVOKE_PLATFORM_ADMIN: '取消平台管理员',
  // 用户类型与多机构分配（v1.18.12）
  UPDATE_USER_TYPE: '修改用户类型',
  ASSIGN_USER_ORG: '分配用户机构',
  REMOVE_USER_ORG: '移出用户机构',
  // 用户联系电话（v1.18.17）
  UPDATE_USER_PHONE: '修改联系电话',
  // 工时配置（v1.18.43）
  UPDATE_TS_CONFIG: '修改工时配置',
  UPDATE_TS_TOKEN: '修改工时服务Token',
};
export const DEPARTMENTS = [
  '内科', '外科', '儿科', '妇产科', '急诊科', '骨科', '神经外科',
  '影像科', '检验科', '药剂科', '超声科', '心电图室', '财务科',
  '门诊办', '护理部', '院办', '信息科', '其他',
];

// 角色权限目录（key 必须与后端 permissions.js 逐字一致）
export const PERM_MENUS = [
  { key: 'dashboard', label: '数据驾驶舱' },
  { key: 'issues', label: '问题登记' },
  { key: 'audited', label: '审核通过' },
  { key: 'kb', label: '运维知识库' },
  { key: 'chat', label: '聊天' },
  { key: 'users', label: '用户管理' },
  { key: 'audit', label: '操作日志' },
  { key: 'settings', label: '系统设置' },
  { key: 'schedule', label: '值班表' },
  { key: 'timesheet', label: '工时登记' },
  { key: 'tsconfig', label: '工时配置' },
];
// 权限设置弹框左栏的模块列表 = 全部菜单 + 不占菜单的功能模块（与后端 PERM_MODULES 一致）。
export const PERM_MODULES = [
  ...PERM_MENUS,
  { key: 'notification', label: '消息通知' },
];
// 平台级功能（跨全部机构生效，不归任何机构角色管辖）：
// 权限矩阵里的角色是「按机构」存储的，而机构管理是跨机构操作，因此不能按机构角色勾选授权
// （否则 A 机构角色就能管 B 机构）。此处仅用于在权限设置弹框左栏显式列出并说明其授权方式，
// 让管理员看清「为什么这里没有开关」；实际授权入口在「用户列表」的「平台管理员」标识，
// 后端由 requirePlatformAdmin() 独立校验。本列表只是界面元数据，不参与权限判定。
export const PLATFORM_MODULES = [
  { key: 'orgs', label: '机构管理', desc: '跨全部机构生效，属于平台级功能，不能按机构角色勾选授权。' },
];
// 功能权限目录：menu 标明该功能隶属哪个菜单（须与后端 permissions.js 的 ACTIONS 逐字一致）。
export const PERM_ACTIONS = [
  { key: 'issue.create', label: '登记问题', menu: 'issues' },
  { key: 'issue.edit', label: '编辑问题', menu: 'issues' },
  { key: 'issue.delete', label: '删除问题', menu: 'issues' },
  { key: 'issue.bulkStatus', label: '批量改状态', menu: 'issues' },
  { key: 'issue.bulkDelete', label: '批量删除问题', menu: 'issues' },
  { key: 'issue.export', label: '导出数据', menu: 'issues' },
  { key: 'issue.rate', label: '问题回访打分', menu: 'issues' },
  { key: 'issue.rateAll', label: '回访全部问题', menu: 'issues' },
  { key: 'user.manage', label: '用户管理', menu: 'users' },
  { key: 'audit.view', label: '查看操作日志', menu: 'audit' },
  { key: 'settings.edit', label: '修改系统设置', menu: 'settings' },
  { key: 'notification.send', label: '发送通知', menu: 'notification' },
  { key: 'notification.broadcast', label: '发送全员通知', menu: 'notification' },
  { key: 'schedule.manage', label: '排班管理', menu: 'schedule' },
  { key: 'issue.audit', label: '审核问题', menu: 'issues' },
  { key: 'chat.use', label: '使用聊天', menu: 'chat' },
];
export const MENU_ORDER = ['dashboard', 'issues', 'audited', 'kb', 'chat', 'users', 'audit', 'settings', 'schedule', 'timesheet', 'tsconfig'];

// 内置角色（与后端 BUILTIN_ROLES 一致）：不可删除，仅可改名。
export const BUILTIN_ROLES = [
  { key: 'admin', label: '管理员', builtin: true },
  { key: 'reporter', label: '登记员', builtin: true },
];

// 角色 key 规则：小写字母开头，含数字/_/-，2~30 位（与后端 ROLE_KEY_RE 一致）。
export const ROLE_KEY_RE = /^[a-z][a-z0-9_-]{1,29}$/;
export function isValidRoleKey(key) { return typeof key === 'string' && ROLE_KEY_RE.test(key.trim()); }

// 拒绝一切权限的兜底（deny-by-default）。
export const DENY_ALL = {
  menus: [],
  actions: Object.fromEntries(PERM_ACTIONS.map((a) => [a.key, false])),
};

// 某角色的默认权限（与后端 defaultRolePermissions 一致）：
// admin 全开；其他角色（含 reporter）一律用「登记员」模板。
export function defaultRolePermissions(roleKey) {
  if (roleKey === 'admin') {
    return {
      menus: PERM_MENUS.map((m) => m.key),
      actions: Object.fromEntries(PERM_ACTIONS.map((a) => [a.key, true])),
    };
  }
  const actions = Object.fromEntries(PERM_ACTIONS.map((a) => [a.key, false]));
  actions['issue.create'] = true;
  actions['issue.edit'] = true;
  actions['issue.bulkStatus'] = true;
  actions['issue.export'] = true;
  actions['issue.rate'] = true;
  actions['chat.use'] = true;
  // 值班表 / 审核通过 / 运维知识库 / 聊天 / 工时登记 / 工时配置默认对登记员等也可见（与原「全员常显」一致），管理员可关闭。
  return { menus: ['dashboard', 'issues', 'audited', 'kb', 'schedule', 'chat', 'timesheet', 'tsconfig'], actions };
}

// 前端兜底默认权限（仅在 /api/config 取不到时使用）
export const DEFAULT_PERMISSIONS = {
  admin: defaultRolePermissions('admin'),
  reporter: defaultRolePermissions('reporter'),
};

const BASE = '/api';
const TOKEN_KEY = 'hit_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

function authHeaders(extra = {}) {
  const token = getToken();
  return token ? { ...extra, Authorization: 'Bearer ' + token } : { ...extra };
}

// —— 文件名编码修复（v1.18.5）——
// 后端 busboy 曾把 multipart 的 filename 按 latin1 解码，中文名会变成「ä¼šè®®çºªè¦.pdf」
// 这种乱码并落库（详见 backend/src/services/uploads.js）。源头已修，但**存量数据**仍是坏的，
// 且前端显示与另存为文件名都取自记录里的 originalName，所以在唯一的 JSON 出口统一做一次还原。
// ⚠️ 与 backend/src/services/uploads.js 的 repairMojibakeName 语义必须一致（测试逐用例比对）。
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

export function repairMojibakeName(name) {
  if (typeof name !== 'string' || !name) return name;
  if (!/[\u0080-\u00ff]/.test(name)) return name; // 纯 ASCII 或纯中文：不可能是 latin1 误解码
  try {
    const bytes = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i += 1) bytes[i] = name.charCodeAt(i) & 0xff;
    const fixed = utf8Fatal.decode(bytes);
    return fixed && fixed !== name ? fixed : name;
  } catch {
    return name; // 不是合法 UTF-8 字节序列 → 原样保留，避免越修越坏
  }
}

// 只改写「已知会承载文件名」的字段值，不改变响应结构。
// 对非乱码字符串是严格 no-op，因此可以安全地跑在每个响应上。
const NAME_KEYS = new Set(['originalName', 'detail']);
export function repairNames(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) {
    for (const item of value) repairNames(item, depth + 1);
    return value;
  }
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (NAME_KEYS.has(k) && typeof v === 'string') value[k] = repairMojibakeName(v);
    else if (v && typeof v === 'object') repairNames(v, depth + 1);
  }
  return value;
}

async function req(url, opts = {}) {
  const res = await fetch(BASE + url, {
    ...opts,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(opts.headers || {}) }),
  });
  if (res.status === 401) clearToken();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return repairNames(data);
}

export const api = {
  login: (username, password) =>
    req('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  me: () => req('/auth/me'),
  // 多机构（v1.18）：切换当前机构 —— 后端重新签发携带新机构声明的 token
  switchOrg: (orgId) => req('/auth/switch-org', { method: 'POST', body: JSON.stringify({ orgId }) }),

  // 机构管理（仅平台管理员可见 / 可用）
  listOrgs: () => req('/orgs'),
  createOrg: (data) => req('/orgs', { method: 'POST', body: JSON.stringify(data) }),
  updateOrg: (id, data) => req('/orgs/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  removeOrg: (id) => req('/orgs/' + id, { method: 'DELETE' }),
  listOrgMembers: (id) => req('/orgs/' + id + '/members'),
  addOrgMember: (id, data) => req('/orgs/' + id + '/members', { method: 'POST', body: JSON.stringify(data) }),
  removeOrgMember: (id, userId) => req('/orgs/' + id + '/members/' + userId, { method: 'DELETE' }),

  list: (params = {}) => req('/problems' + qs(params)),
  stats: () => req('/problems/stats'),
  get: (id) => req('/problems/' + id),
  create: (data) => req('/problems', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => req('/problems/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id) => req('/problems/' + id, { method: 'DELETE' }),
  // 回收站（v1.6 软删除）：恢复 / 彻底删除
  restoreProblem: (id) => req(`/problems/${id}/restore`, { method: 'POST' }),
  hardDeleteProblem: (id) => req(`/problems/${id}/hard`, { method: 'DELETE' }),
  bulkStatus: (ids, status) => req('/problems/bulk/status', { method: 'POST', body: JSON.stringify({ ids, status }) }),
  bulkDelete: (ids) => req('/problems/bulk/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  // 回访满意度打分（登记人本人或管理员）
  rateSatisfaction: (id, data) => req(`/problems/${id}/satisfaction`, { method: 'POST', body: JSON.stringify(data) }),
  // 审核问题（需 issue.audit 权限）：result = 'approve' | 'reject'，reject 必须带 reason
  auditIssue: (id, data) => req(`/problems/${id}/audit`, { method: 'POST', body: JSON.stringify(data) }),
  // 趋势聚合（按科室 + 按月度）
  trend: () => req('/problems/trend'),
  // 数据驾驶舱：多维度统计
  dashboard: () => req('/problems/dashboard'),
  exportBlob: async (params = {}) => {
    const res = await fetch(BASE + '/problems/export' + qs(params), { headers: authHeaders() });
    if (!res.ok) throw new Error('导出失败');
    return res.blob();
  },
  // v1.18.24：底稿登记清单导出（审核通过菜单）。空结果时后端 400 带中文 error，透传给界面提示
  exportDraftBlob: async (params = {}) => {
    const res = await fetch(BASE + '/problems/export-draft' + qs(params), { headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '导出失败');
    }
    return res.blob();
  },

  // 运维知识库（v1.18.27）：写了处理说明的问题自动收录（派生视图、只读）
  kbList: (params = {}) => req('/problems/kb' + qs(params)),

  // 修改本人密码
  changePassword: (oldPassword, newPassword) =>
    req('/auth/password', { method: 'PUT', body: JSON.stringify({ oldPassword, newPassword }) }),

  // 系统配置（config 公开；settings 仅管理员）
  getConfig: () => req('/config'),
  updateSettings: (data) => req('/settings', { method: 'PUT', body: JSON.stringify(data) }),

  // 用户管理（管理员）
  listUsers: () => req('/users'),
  listUsersLookup: () => req('/users/lookup'),   // 任意已登录用户：仅返回 {username,name}，用于登记人下拉
  createUser: (data) => req('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUserRole: (id, role) => req('/users/' + id + '/role', { method: 'PUT', body: JSON.stringify({ role }) }),
  resetPassword: (id, password) => req(`/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) }),
  setUserStatus: (id, active) => req(`/users/${id}/status`, { method: 'PUT', body: JSON.stringify({ active }) }),
  // 平台管理员指派（额外要求调用者本人是平台管理员）
  setUserPlatformAdmin: (id, platformAdmin) =>
    req(`/users/${id}/platform-admin`, { method: 'PUT', body: JSON.stringify({ platformAdmin }) }),
  // 用户类型（v1.18.12，仅平台管理员）：'hospital'=院方 / 'company'=公司
  setUserType: (id, userType) => req(`/users/${id}/type`, { method: 'PUT', body: JSON.stringify({ userType }) }),
  // 联系电话（v1.18.17）：账号级字段，权限边界与重置密码一致（后端 loadOwnableTarget 兜底）
  updateUserPhone: (id, phone) => req(`/users/${id}/phone`, { method: 'PUT', body: JSON.stringify({ phone }) }),
  // 公司用户多机构分配（v1.18.12，仅平台管理员）
  listUserMemberships: (id) => req(`/users/${id}/memberships`),
  addUserMembership: (id, data) => req(`/users/${id}/memberships`, { method: 'POST', body: JSON.stringify(data) }),
  removeUserMembership: (id, orgId) => req(`/users/${id}/memberships/${orgId}`, { method: 'DELETE' }),

  // 审计日志（管理员）
  listAudit: (params = {}) => req('/audit' + qs(params)),
  auditExportBlob: async (params = {}) => {
    const res = await fetch(BASE + '/audit/export' + qs(params), { headers: authHeaders() });
    if (!res.ok) throw new Error('导出失败');
    return res.blob();
  },

  // 附件
  uploadAttachment: async (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${BASE}/problems/${id}/attachments`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '上传失败');
    return repairNames(data);
  },
  deleteAttachment: (id, fileId) =>
    req(`/problems/${id}/attachments/${fileId}`, { method: 'DELETE' }),
  // 取回附件二进制（供详情抽屉在线预览：blob → objectURL，浏览器内存中展示，不落盘）
  fetchAttachmentBlob: async (id, fileId) => {
    const res = await fetch(`${BASE}/problems/${id}/attachments/${fileId}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('附件加载失败');
    return res.blob();
  },
  downloadAttachment: async (id, fileId, filename) => {
    const res = await fetch(`${BASE}/problems/${id}/attachments/${fileId}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('下载失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'attachment';
    a.click();
    URL.revokeObjectURL(url);
  },

  // 消息通知
  listNotifications: (params = {}) => req('/notifications' + qs(params)),
  notificationsUnreadCount: () => req('/notifications/unread-count'),
  sendNotification: (data) => req('/notifications', { method: 'POST', body: JSON.stringify(data) }),

  // 聊天（AI 助手 + 同事会话）：轮询刷新，详见 components/Chat.vue
  chatUnread: () => req('/chat/unread'),
  chatAiConversation: () => req('/chat/ai'),
  listConversations: () => req('/chat/conversations'),
  createConversation: (data) => req('/chat/conversations', { method: 'POST', body: JSON.stringify(data) }),
  listMessages: (id, params = {}) => req('/chat/conversations/' + id + '/messages' + qs(params)),
  sendChatMessage: (id, body, attachments) => req('/chat/conversations/' + id + '/messages', { method: 'POST', body: JSON.stringify({ body, attachments }) }),
  // v1.18.22：引用问题到聊天 —— body 为可选留言，ref 仅携带 { id }（快照由后端从问题库读取）。
  sendChatMessageWithRef: (id, body, ref) => req('/chat/conversations/' + id + '/messages', { method: 'POST', body: JSON.stringify({ body, ref }) }),
  markChatRead: (id) => req('/chat/conversations/' + id + '/read', { method: 'PUT' }),
  // v1.18.14：撤回自己发送的消息（AI 会话属主也可撤回 assistant 回复）；幂等
  recallMessage: (convId, mid) => req(`/chat/conversations/${convId}/messages/${mid}/recall`, { method: 'POST' }),
  // v1.18.14：移除左侧会话列表中的会话 —— AI 会话=删除，同事会话=退出
  removeConversation: (convId) => req('/chat/conversations/' + convId, { method: 'DELETE' }),
  // 聊天附件：上传后取回元数据，随消息一起发送；图片走 blob 预览（带鉴权头）
  uploadChatAttachment: async (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${BASE}/chat/conversations/${id}/attachments`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '附件上传失败');
    return repairNames(data);
  },
  chatAttachmentBlob: async (storedName) => {
    const res = await fetch(`${BASE}/chat/attachments/${encodeURIComponent(storedName)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('附件加载失败');
    return res.blob();
  },
  downloadChatAttachment: async (storedName, filename) => {
    const res = await fetch(`${BASE}/chat/attachments/${encodeURIComponent(storedName)}?download=1`, { headers: authHeaders() });
    if (!res.ok) throw new Error('下载失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || storedName;
    a.click();
    URL.revokeObjectURL(url);
  },
  broadcastNotification: (data) => req('/notifications/broadcast', { method: 'POST', body: JSON.stringify(data) }),
  markNotificationRead: (id) => req('/notifications/' + id + '/read', { method: 'PUT' }),
  markAllNotificationsRead: () => req('/notifications/read-all', { method: 'PUT' }),

  // 值班表（排班）：查看对全员开放，写操作需 schedule.manage 权限
  listSchedules: (params = {}) => req('/schedules' + qs(params)),
  createSchedule: (data) => req('/schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateSchedule: (id, data) => req('/schedules/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  removeSchedule: (id) => req('/schedules/' + id, { method: 'DELETE' }),
  copySchedules: (data) => req('/schedules/copy-week', { method: 'POST', body: JSON.stringify(data) }),
  // 跨机构同步排班（v1.18.13，仅平台管理员）：direction = 'push' | 'pull'
  syncSchedules: (data) => req('/schedules/sync', { method: 'POST', body: JSON.stringify(data) }),

  // 用户在线状态（v1.18.41）：返回 { online: [username...], windowMs } —— 最近 90s 内有过认证请求的账号
  userPresence: () => req('/users/presence'),

  // —— 实施协同 · 工时登记（v1.18.40）：本系统仅代理，业务由 WXP底稿+PMIS 系统承担 ——
  // 工时登记（v1.18.42 原生集成：后端 src/timesheet/ 本地实现 PMIS-MCP/WXP 链路；v1.18.43 起配置按用户隔离）。
  tsConfig: () => req('/timesheet/config'),
  tsHospitals: () => req('/timesheet/hospitals'),
  tsProjects: (params = {}) => req('/timesheet/projects' + qs(params)),
  tsSaveProject: (data) => req('/timesheet/save-project', { method: 'POST', body: JSON.stringify(data) }),
  tsUnfilled: (params = {}) => req('/timesheet/unfilled' + qs(params)),
  tsDrafts: (params = {}) => req('/timesheet/drafts' + qs(params)),
  tsBatchDrafts: (params = {}) => req('/timesheet/batch-drafts' + qs(params)),
  tsSubmit: (data) => req('/timesheet/submit', { method: 'POST', body: JSON.stringify(data) }),
  tsBatchSubmit: (entries) => req('/timesheet/batch-submit', { method: 'POST', body: JSON.stringify(entries) }),
  tsKb: () => req('/timesheet/kb'),
  tsKbRandom: (count = 3) => req('/timesheet/kb-random' + qs({ count })),
  tsKbAdd: (data) => req('/timesheet/kb-add', { method: 'POST', body: JSON.stringify(data) }),
  tsKbDelete: (data) => req('/timesheet/kb-delete', { method: 'POST', body: JSON.stringify(data) }),
  // 工时配置（v1.18.43）：每个登录用户自己的配置记录（个人 WXP 账号/默认值/医院绑定）
  tsMyConfig: () => req('/timesheet/my-config'),
  tsSaveMyConfig: (data) => req('/timesheet/my-config', { method: 'PUT', body: JSON.stringify(data) }),
  tsTestLogin: (data) => req('/timesheet/my-config/test', { method: 'POST', body: JSON.stringify(data) }),
  // 服务连接（v1.18.46，仅平台管理员）：PMIS-MCP Token 界面化维护（非管理员 403 → 前端隐藏卡片）
  tsServerConfig: () => req('/timesheet/server-config'),
  tsUpdateServerToken: (token) => req('/timesheet/server-config', { method: 'PUT', body: JSON.stringify({ token }) }),
};
