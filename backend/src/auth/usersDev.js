import fs from 'node:fs/promises';
import path from 'node:path';
import { hashPassword } from './password.js';

// dev / 测试用：本地 JSON 文件用户仓库，无需数据库。
export function createDevUserStore(filePath) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      cache = JSON.parse(raw);
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      cache = [];
      await fs.writeFile(filePath, '[]', 'utf8');
    }
    return cache;
  }

  async function save(data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    cache = data;
  }

  const isActive = (u) => u.active !== false;
  const isPlatformAdmin = (u) => u.is_platform_admin === true;
  // 用户类型（v1.18.12）：'hospital'=院方 / 'company'=公司（公司用户可归属多机构）。
  // 存量数据缺省视为院方，与 mssql 侧 WITH VALUES 'hospital' 的加列默认值保持一致。
  const userTypeOf = (u) => (u && u.user_type === 'company' ? 'company' : 'hospital');

  return {
    async ensureSeed(seed) {
      const users = await load();
      if (users.length === 0) {
        users.push({
          id: 1,
          username: seed.username,
          name: seed.name || seed.username,
          role: 'admin',
          active: true,
          // 首个（内置）管理员即平台管理员，可跨机构管理；后续可在用户管理中调整。
          is_platform_admin: true,
          user_type: 'hospital',
          password: await hashPassword(seed.password),
        });
        await save(users);
      }
    },
    async findByUsername(username) {
      const users = await load();
      const u = users.find((x) => x.username === username) || null;
      return u ? { ...u, active: isActive(u), platformAdmin: isPlatformAdmin(u), userType: userTypeOf(u) } : null;
    },
    async findById(id) {
      const users = await load();
      const u = users.find((x) => String(x.id) === String(id)) || null;
      return u ? { ...u, active: isActive(u), platformAdmin: isPlatformAdmin(u), userType: userTypeOf(u) } : null;
    },
    async list() {
      const users = await load();
      return users.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        active: isActive(u),
        platformAdmin: isPlatformAdmin(u),
        userType: userTypeOf(u),
        phone: u.phone || '',
        // 最近登录时间（v1.18.44）：ISO 字符串或 null（从未登录）。
        lastLoginAt: u.last_login_at || null,
      }));
    },
    async create({ username, name, role, password, userType, phone }) {
      const users = await load();
      if (users.find((u) => u.username === username)) return null;
      const id = users.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0) + 1;
      const type = userType === 'company' ? 'company' : 'hospital';
      const ph = typeof phone === 'string' ? phone.trim() : '';
      const user = { id, username, name: name || username, role: role || 'reporter', active: true, user_type: type, phone: ph, password };
      users.push(user);
      await save(users);
      return { id, username: user.username, name: user.name, role: user.role, active: true, platformAdmin: false, userType: type, phone: ph };
    },
    // 用户类型（v1.18.12）：'hospital' | 'company'。调用方的业务守卫（多机构归属等）由路由层负责。
    async setUserType(id, type) {
      const users = await load();
      const idx = users.findIndex((u) => String(u.id) === String(id));
      if (idx === -1) return false;
      users[idx].user_type = type === 'company' ? 'company' : 'hospital';
      await save(users);
      return true;
    },
    // 联系电话（v1.18.17）：账号级、全局唯一字段。边界守卫（平台管理员 / 本机构专属账号）由路由层负责。
    async setPhone(id, phone) {
      const users = await load();
      const idx = users.findIndex((u) => String(u.id) === String(id));
      if (idx === -1) return false;
      users[idx].phone = typeof phone === 'string' ? phone.trim() : '';
      await save(users);
      return true;
    },
    async setPassword(id, hashed) {
      const users = await load();
      const idx = users.findIndex((u) => String(u.id) === String(id));
      if (idx === -1) return false;
      users[idx].password = hashed;
      await save(users);
      return true;
    },
    async setActive(id, active) {
      const users = await load();
      const idx = users.findIndex((u) => String(u.id) === String(id));
      if (idx === -1) return false;
      users[idx].active = !!active;
      await save(users);
      return true;
    },
    // 最近登录时间（v1.18.44）：登录成功即记录（ISO 字符串）。只记「登录」事件——
    // 认证请求刷新的是在线状态（presence.js），两者语义不同。
    async touchLogin(id, when) {
      const users = await load();
      const idx = users.findIndex((u) => String(u.id) === String(id));
      if (idx === -1) return false;
      users[idx].last_login_at = when || new Date().toISOString();
      await save(users);
      return true;
    },
    // ⚠️ 写的是「全局角色」app_user.role。机构级接口（如 PUT /api/users/:id/role）不要调用它 ——
    // 全局角色是「无成员关系机构」的角色回落来源，回写会把本机构的改动泄漏到其它机构。
    // 机构内角色请用 orgs 存储的 setMember(userId, orgId, role)。见 v1.18.3。
    async setRole(id, role) {
      const users = await load();
      const idx = users.findIndex((u) => String(u.id) === String(id));
      if (idx === -1) return false;
      users[idx].role = role;
      await save(users);
      return {
        id: users[idx].id,
        username: users[idx].username,
        name: users[idx].name,
        role,
        active: isActive(users[idx]),
        platformAdmin: isPlatformAdmin(users[idx]),
        userType: userTypeOf(users[idx]),
      };
    },
    // 平台管理员标记（v1.18）：可跨机构管理。
    async setPlatformAdmin(id, flag) {
      const users = await load();
      const idx = users.findIndex((u) => String(u.id) === String(id));
      if (idx === -1) return false;
      users[idx].is_platform_admin = !!flag;
      await save(users);
      return true;
    },
  };
}
