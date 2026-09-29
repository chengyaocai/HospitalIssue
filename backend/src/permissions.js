// 角色权限模型：定义「菜单权限」与「功能权限」目录、内置角色、默认权限与归一化。
// 前端据此显隐菜单/按钮，后端 requirePermission() 据此做接口级鉴权。
// 角色不再写死：内置角色始终存在，管理员可自行新增/改名/删除自定义角色。

export const MENUS = [
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

// 权限设置弹框左栏的模块列表 = 全部菜单 + 不占菜单的功能模块。
// notification 不是菜单，所有登录用户都能收通知，只是一个「可授权的功能模块」。
// schedule / audited 已升级为「真正的权限菜单」（进入 MENUS），故不再单列。
export const PERM_MODULES = [
  ...MENUS,
  { key: 'notification', label: '消息通知' },
];

// 平台级功能（跨全部机构生效，不归任何机构角色管辖）。
// 仅作为「权限模型」的完整定义与前端 api.js 的 PLATFORM_MODULES 保持一致（供核对），
// 后端鉴权不读取本列表：平台管理员身份来自 app_user.is_platform_admin，由
// requirePlatformAdmin() / routes/auth.js 校验。切勿把它塞进 MENUS 或 ACTIONS——
// 角色是按机构存储的，一旦可授权就等于让 A 机构角色去管 B 机构。
export const PLATFORM_MODULES = [
  { key: 'orgs', label: '机构管理', desc: '跨全部机构生效，属于平台级功能，不能按机构角色勾选授权。' },
];

// 功能权限目录：menu 为纯元数据，标明该功能隶属哪个菜单（不影响任何接口响应；
// 须与前端 api.js 的 PERM_ACTIONS 逐字一致，用于「按菜单分组」展示权限矩阵）。
export const ACTIONS = [
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

// 内置角色：不可删除，仅可改名。
export const BUILTIN_ROLES = [
  { key: 'admin', label: '管理员', builtin: true },
  { key: 'reporter', label: '登记员', builtin: true },
];

// 角色 key 规则：小写字母开头，含数字/_/-，2~30 位。
export const ROLE_KEY_RE = /^[a-z][a-z0-9_-]{1,29}$/;

// 拒绝一切权限的兜底（deny-by-default）：未知角色一律按此处理。
export const DENY_ALL = {
  menus: [],
  actions: Object.fromEntries(ACTIONS.map((a) => [a.key, false])),
};

const allMenus = MENUS.map((m) => m.key);

// 某角色的默认权限：
// - admin：菜单全开 + 动作全 true；
// - 其他角色（含 reporter）：一律用「登记员」模板 —— 可看驾驶舱/问题登记，
//   可登记/编辑/批量改状态/导出/回访，但不能删除、不能进用户管理与日志与设置。
export function defaultRolePermissions(roleKey) {
  if (roleKey === 'admin') {
    const actions = {};
    for (const a of ACTIONS) actions[a.key] = true;
    return { menus: [...allMenus], actions };
  }
  const actions = {};
  for (const a of ACTIONS) actions[a.key] = false;
  actions['issue.create'] = true;
  actions['issue.edit'] = true;
  actions['issue.bulkStatus'] = true;
  actions['issue.export'] = true;
  actions['issue.rate'] = true;
  actions['chat.use'] = true;
  // 值班表 / 审核通过 / 运维知识库 / 聊天 / 工时登记 / 工时配置 为「全员常显」升级而来的权限菜单，
  // 默认对登记员等也可见，保持与原「全员常显」行为一致（管理员可在权限矩阵中按需关闭）。
  return { menus: ['dashboard', 'issues', 'audited', 'kb', 'schedule', 'chat', 'timesheet', 'tsconfig'], actions };
}

// 把任意输入（数组 / JSON 字符串 / 缺失）归一化为合法角色列表：
// - 始终包含内置角色（admin / reporter）；允许改内置角色的 label，但不允许删除其 key；
// - 非法 key / 空 label 丢弃；label 截断 ≤24 字符；按 key 去重（内置优先保留）。
export function normalizeRoles(stored) {
  const src = Array.isArray(stored) ? stored : [];
  const labelByKey = new Map();
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (!ROLE_KEY_RE.test(key) || labelByKey.has(key)) continue;
    const label = typeof item.label === 'string' ? item.label.trim().slice(0, 24) : '';
    if (!label) continue;
    labelByKey.set(key, label);
  }
  const out = [];
  const added = new Set();
  // 内置角色始终排在最前，保证存在性。
  for (const b of BUILTIN_ROLES) {
    const label = (labelByKey.get(b.key) || b.label).slice(0, 24);
    out.push({ key: b.key, label, builtin: true });
    added.add(b.key);
  }
  // 其余自定义角色按输入顺序追加。
  for (const [key, label] of labelByKey.entries()) {
    if (added.has(key)) continue;
    out.push({ key, label, builtin: false });
    added.add(key);
  }
  return out;
}

// 以 roles 为基准，把任意权限输入归一化为「合法的完整权限表」：
// - 未知角色丢弃；非法菜单 key 丢弃；
// - 非布尔的 action 回落 defaultRolePermissions(role) 的值；缺失项补全。
export function normalizePermissions(stored, roles) {
  const list = Array.isArray(roles) ? roles : BUILTIN_ROLES;
  const isObj = stored && typeof stored === 'object' && !Array.isArray(stored);
  const out = {};
  for (const r of list) {
    const role = typeof r === 'string' ? r : r && r.key;
    if (!role) continue;
    const def = defaultRolePermissions(role);
    const src = isObj ? stored[role] : null;
    const menus = Array.isArray(src?.menus)
      ? [...new Set(src.menus.map(String).filter((k) => MENUS.some((m) => m.key === k)))]
      : [...def.menus];
    const actions = {};
    for (const a of ACTIONS) {
      actions[a.key] = src && src.actions && typeof src.actions[a.key] === 'boolean'
        ? src.actions[a.key]
        : def.actions[a.key];
    }
    out[role] = { menus, actions };
  }
  return out;
}

// 取某角色的有效权限：deny-by-default，不再回落到 reporter。
export function permissionsFor(perms, role) {
  if (perms && typeof perms === 'object' && perms[role]) return perms[role];
  return DENY_ALL;
}

// 「锁死保护」判定：是否存在某个角色同时具备「用户管理」与「修改系统设置」权限。
export function hasPrivilegedRole(perms) {
  if (!perms || typeof perms !== 'object') return false;
  return Object.values(perms).some(
    (p) => p && p.actions && p.actions['user.manage'] === true && p.actions['settings.edit'] === true
  );
}
