import { config } from '../config.js';
import { createDevSettingsStore } from './devSettingsStore.js';
import { createMssqlSettingsStore } from './mssqlSettingsStore.js';
import { normalizePermissions, normalizeRoles, hasPrivilegedRole } from '../permissions.js';

let store;

async function getStore() {
  if (store) return store;
  store = config.dbDriver === 'dev'
    ? createDevSettingsStore(config.settingsDevPath)
    : createMssqlSettingsStore(config.mssql);
  return store;
}

// 把任意输入规范化为「非空字符串数组」，上限 500 项，用于下拉配置项（处理人 / 软件系统）
function toLines(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, 500);
}

// 读取时兼容两种存储形态：
// - dev 模式直接存数组；
// - mssql 模式把数组 JSON 字符串化后存于 value 列。
// 统一解析为数组，缺失则返回空数组。
function asArray(v) {
  if (Array.isArray(v)) return toLines(v);
  if (typeof v === 'string' && v.length) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? toLines(parsed) : [];
    } catch {
      // 旧数据若是纯文本（逗号分隔），兜底按逗号拆分
      return toLines(v.split(','));
    }
  }
  return [];
}

// 处理人候选名单归一化为 { empId, name, phone } 结构（工号 / 电话均可空）。
// 兼容旧数据：
// - 纯文本字符串 "张三" -> { empId: '', name: '张三', phone: '' }
// - 旧对象 { name, phone }    -> { empId: '', name, phone }
// - 新对象 { empId, name, phone } -> 原样（字段裁剪）
// 无有效姓名的条目丢弃，避免脏数据。
function asHandlerEntry(x) {
  if (x == null) return null;
  if (typeof x === 'string') {
    const name = x.trim();
    return name ? { empId: '', name, phone: '' } : null;
  }
  if (typeof x === 'object') {
    const name = String(x.name ?? '').trim();
    if (!name) return null;
    const empId = typeof x.empId === 'string' ? x.empId.trim().slice(0, 30) : '';
    const phone = typeof x.phone === 'string' ? x.phone.trim().slice(0, 30) : '';
    return { empId, name, phone };
  }
  return null;
}

// 读取时把任意存储形态（数组 / JSON 字符串）统一归一化为 { empId, name, phone } 数组。
function asHandlers(v) {
  if (Array.isArray(v)) {
    return v.map(asHandlerEntry).filter(Boolean).slice(0, 500);
  }
  if (typeof v === 'string' && v.length) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? asHandlers(parsed) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// 读取角色列表：兼容数组 / JSON 字符串两种存储形态，并始终归一化为含内置角色的合法列表。
function asRoles(v) {
  if (Array.isArray(v)) return normalizeRoles(v);
  if (typeof v === 'string' && v.length) {
    try { return normalizeRoles(JSON.parse(v)); } catch { return normalizeRoles(null); }
  }
  return normalizeRoles(null);
}

// 读取权限：兼容对象 / JSON 字符串两种存储形态，按传入的 roles 归一化为完整结构。
function asPermissions(v, roles) {
  if (typeof v === 'string' && v.length) {
    try { return normalizePermissions(JSON.parse(v), roles); } catch { return normalizePermissions(null, roles); }
  }
  return normalizePermissions(v, roles);
}

// 一次性存量迁移：本特性新增 schedule / audited 两个「权限菜单」key。
// 旧版权限数据（roles 的 menus 里缺这俩 key）加载时逐角色补缺并写回存储；
// 通过持久化标记保证「只跑一次」。v1.6 判据加固：由「任一角色含任一新键即整体跳过」
// 改为「逐角色补缺」——半配置态（如 A 角色只有 audited 没 schedule）也能补齐缺失键。
const MIGRATED_MENUS_FLAG = 'perm_menus_migrated_v1';
const NEW_MENU_KEYS = ['schedule', 'audited'];

// —— v1.18.31 一次性存量迁移（v2）：运维知识库菜单 key 'kb' ——
// 背景：normalizePermissions 对存量权限只过滤非法 key、**不会新增**菜单 key，老库所有角色的
// menus 里都没有 'kb' → 升级后「运维知识库」菜单不显示（多机构运行库的机构级设置同样缺）。
// 与 v1.6 迁移同模式：逐角色补 'kb' 并写回，标记持久化保证只跑一次；管理员之后手动移除
// 'kb' 不会被再次加回（标记已置）。区别于 v1.6：**按「全局 + 各机构」分别迁移**（标记存各自
// settings），因为多机构运行库的机构级设置是从复制时的全局快照来的、同样缺 'kb'。
const MIGRATED_MENUS_FLAG_V2 = 'perm_menus_migrated_v2';
const NEW_MENU_KEYS_V2 = ['kb'];

// —— v1.18.40 一次性存量迁移（v3）：实施协同 · 工时登记菜单 key 'timesheet' ——
// 与 v2 同模式：全局与各机构各自跑一次、幂等；管理员之后手动移除不会被再次加回。
const MIGRATED_MENUS_FLAG_V3 = 'perm_menus_migrated_v3';
const NEW_MENU_KEYS_V3 = ['timesheet'];

// —— v1.18.43 一次性存量迁移（v4）：工时配置菜单 key 'tsconfig' ——
// 与 v3 同模式：全局与各机构各自跑一次、幂等；管理员之后手动移除不会被再次加回。
const MIGRATED_MENUS_FLAG_V4 = 'perm_menus_migrated_v4';
const NEW_MENU_KEYS_V4 = ['tsconfig'];

// 合并：存储覆盖 > 环境变量默认
// orgId 缺省（null/undefined）= 读取遗留的全局设置（单机构 / 升级前行为不变）；
// 传入 orgId 时读取该机构自己的设置（多机构模式）。
export async function getSettings(orgId) {
  const store = await getStore();
  const stored = await store.get(orgId);
  // 先归一化 roles，再据其归一化 permissions（permissions 结构依赖 roles）。
  const roles = asRoles(stored.roles);
  const permissions = asPermissions(stored.permissions, roles);

  // —— 一次性迁移（仅旧数据缺新菜单 key 时触发；已迁移过则跳过）——
  // 只对「全局（遗留）设置」执行：机构级设置是从全局复制而来，本身已是归一化结果。
  if (orgId == null && !stored[MIGRATED_MENUS_FLAG]) {
    // 逐角色补缺：每个角色独立检查 NEW_MENU_KEYS，缺哪个补哪个（半配置态也能补齐）。
    let changed = false;
    for (const r of roles) {
      const p = permissions[r.key];
      if (!p) continue;
      const set = new Set(Array.isArray(p.menus) ? p.menus : []);
      let roleChanged = false;
      for (const k of NEW_MENU_KEYS) {
        if (!set.has(k)) { set.add(k); roleChanged = true; }
      }
      if (roleChanged) {
        p.menus = [...set];
        changed = true;
      }
    }
    if (changed) {
      // 有补缺：连 permissions 一起写回（保留管理员已做的其它配置）。
      await store.update({
        permissions: JSON.stringify(permissions),
        [MIGRATED_MENUS_FLAG]: '1',
      });
    } else {
      // 全新安装（所有角色均已含新菜单）：仅置标记，避免后续重复判断与写回。
      await store.update({ [MIGRATED_MENUS_FLAG]: '1' });
    }
  }

  // —— v1.18.31 迁移（v2）：补 'kb' 菜单 key（全局与各机构各自跑一次，幂等）——
  if (!stored[MIGRATED_MENUS_FLAG_V2]) {
    let changedV2 = false;
    for (const r of roles) {
      const p = permissions[r.key];
      if (!p) continue;
      const set = new Set(Array.isArray(p.menus) ? p.menus : []);
      if (!set.has('kb')) { set.add('kb'); p.menus = [...set]; changedV2 = true; }
    }
    await store.update(
      changedV2
        ? { permissions: JSON.stringify(permissions), [MIGRATED_MENUS_FLAG_V2]: '1' }
        : { [MIGRATED_MENUS_FLAG_V2]: '1' },
      orgId,
    );
  }

  // —— v1.18.40 迁移（v3）：补 'timesheet' 菜单 key（全局与各机构各自跑一次，幂等）——
  if (!stored[MIGRATED_MENUS_FLAG_V3]) {
    let changedV3 = false;
    for (const r of roles) {
      const p = permissions[r.key];
      if (!p) continue;
      const set = new Set(Array.isArray(p.menus) ? p.menus : []);
      if (!set.has('timesheet')) { set.add('timesheet'); p.menus = [...set]; changedV3 = true; }
    }
    await store.update(
      changedV3
        ? { permissions: JSON.stringify(permissions), [MIGRATED_MENUS_FLAG_V3]: '1' }
        : { [MIGRATED_MENUS_FLAG_V3]: '1' },
      orgId,
    );
  }

  // —— v1.18.43 迁移（v4）：补 'tsconfig' 菜单 key（全局与各机构各自跑一次，幂等）——
  if (!stored[MIGRATED_MENUS_FLAG_V4]) {
    let changedV4 = false;
    for (const r of roles) {
      const p = permissions[r.key];
      if (!p) continue;
      const set = new Set(Array.isArray(p.menus) ? p.menus : []);
      if (!set.has('tsconfig')) { set.add('tsconfig'); p.menus = [...set]; changedV4 = true; }
    }
    await store.update(
      changedV4
        ? { permissions: JSON.stringify(permissions), [MIGRATED_MENUS_FLAG_V4]: '1' }
        : { [MIGRATED_MENUS_FLAG_V4]: '1' },
      orgId,
    );
  }

  return {
    appName: stored.appName || config.appName,
    // deprecated v1.18.16：config（GET /api/config）已改为**派生自机构公司用户**
    //（见 routes/settings.js 的 deriveHandlersFromOrgUsers），不再读取此处存储的手工名单。
    // 该字段仅为「PUT /api/settings 兼容旧前端 / 数据留档」而保留读取与归一化，不对外生效。
    handlers: asHandlers(stored.handlers),
    softwareSystems: asArray(stored.softwareSystems),
    roles,
    permissions,
  };
}

// 把「全局（遗留）系统设置」一次性复制为某机构的机构级设置。
// 幂等：该机构已有任何机构级设置则不覆盖，直接返回 false。
// 升级路径下由 orgs/ensureOrgs 在首次请求时调用 —— 使默认机构「继承」升级前的全部配置。
export async function copyGlobalSettingsToOrg(orgId) {
  if (orgId == null) return false;
  const store = await getStore();
  const existing = await store.get(orgId);
  if (existing && Object.keys(existing).length) return false;
  // 先跑一遍全局读取，顺带完成全局侧的归一化迁移（角色补缺等）。
  await getSettings();
  const global = await store.get();
  const patch = {};
  for (const k of Object.keys(global)) {
    if (k === '__orgs') continue; // dev 驱动的机构级设置容器，不参与复制
    patch[k] = global[k];
  }
  if (Object.keys(patch).length) await store.update(patch, orgId);
  return true;
}

export async function updateSettings(patch = {}, orgId) {
  const clean = {};
  if (typeof patch.appName === 'string' && patch.appName.trim()) {
    clean.appName = patch.appName.trim().slice(0, 60);
  }
  if (Array.isArray(patch.handlers)) {
    // deprecated v1.18.16：config 已改派生自机构公司用户，此存储仅留档（不再被 GET /api/config 读取）。
    // 仍接受并归一化写入（200 而非 400），保证部署窗口期旧前端「保存设置」不报错、且可随时回滚到旧行为。
    // 归一化为 { empId, name, phone } 对象数组，再以 JSON 字符串存储（dev / mssql 通用）。
    // 无有效姓名的条目丢弃；兼容前端传来纯文本 / 旧对象 / 新对象三种形态。
    clean.handlers = JSON.stringify(
      patch.handlers.map(asHandlerEntry).filter(Boolean).slice(0, 500)
    );
  }
  if (Array.isArray(patch.softwareSystems)) {
    clean.softwareSystems = JSON.stringify(toLines(patch.softwareSystems));
  }

  const hasRoles = Array.isArray(patch.roles);
  const hasPerms = patch.permissions && typeof patch.permissions === 'object' && !Array.isArray(patch.permissions);

  if (hasRoles || hasPerms) {
    // roles 与 permissions 同时到达时，按「先 roles 再 permissions」处理。
    const stored = await (await getStore()).get(orgId);
    const roles = hasRoles ? normalizeRoles(patch.roles) : asRoles(stored.roles);
    const permsSource = hasPerms ? patch.permissions : stored.permissions;
    const permissions = asPermissions(permsSource, roles);
    // 锁死保护：不允许把系统调到「没有任何角色同时具备用户管理 + 修改系统设置」的死角。
    if (!hasPrivilegedRole(permissions)) {
      const err = new Error('保存失败：至少需要保留一个角色同时具备『用户管理』与『修改系统设置』权限');
      err.status = 400;
      throw err;
    }
    if (hasRoles) clean.roles = JSON.stringify(roles);
    if (hasPerms) clean.permissions = JSON.stringify(permissions);
  }

  if (Object.keys(clean).length) await (await getStore()).update(clean, orgId);
  return getSettings(orgId);
}
