import fs from 'node:fs/promises';
import path from 'node:path';

// dev / 测试用：本地 JSON 机构与成员关系存储（无需数据库）。
// 文件结构：{ orgs: [...], members: [...] }
// - orgs:    { id, code, name, active, created_at }
// - members: { user_id, org_id, role, created_at }   —— 一个用户可归属多个机构，各机构内可有不同角色
export function createDevOrgStore(filePath) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      cache = {
        orgs: Array.isArray(raw.orgs) ? raw.orgs : [],
        members: Array.isArray(raw.members) ? raw.members : [],
      };
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      cache = { orgs: [], members: [] };
      await fs.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf8');
    }
    return cache;
  }

  async function save() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf8');
  }

  const mapOrg = (o) => ({
    id: o.id,
    code: o.code,
    name: o.name,
    active: o.active !== false,
    created_at: o.created_at || null,
  });
  const mapMember = (m) => ({ user_id: m.user_id, org_id: m.org_id, role: m.role || 'reporter' });

  return {
    async list() {
      const d = await load();
      return d.orgs.slice().sort((a, b) => Number(a.id) - Number(b.id)).map(mapOrg);
    },
    async get(id) {
      const d = await load();
      const o = d.orgs.find((x) => String(x.id) === String(id));
      return o ? mapOrg(o) : null;
    },
    async findByCode(code) {
      const d = await load();
      const o = d.orgs.find((x) => x.code === code);
      return o ? mapOrg(o) : null;
    },
    async create({ code, name }) {
      const d = await load();
      if (code && d.orgs.some((x) => x.code === code)) return null;
      const id = d.orgs.reduce((m, o) => Math.max(m, Number(o.id) || 0), 0) + 1;
      const org = {
        id,
        code: code || `org${id}`,
        name: String(name || '').trim() || `机构${id}`,
        active: true,
        created_at: new Date().toISOString(),
      };
      d.orgs.push(org);
      await save();
      return mapOrg(org);
    },
    async update(id, patch = {}) {
      const d = await load();
      const o = d.orgs.find((x) => String(x.id) === String(id));
      if (!o) return null;
      if (typeof patch.name === 'string' && patch.name.trim()) o.name = patch.name.trim().slice(0, 60);
      if (typeof patch.active === 'boolean') o.active = patch.active;
      await save();
      return mapOrg(o);
    },
    // 删除机构会连带清理其成员关系（守卫「至少保留一个机构」由上层负责）。
    async remove(id) {
      const d = await load();
      const i = d.orgs.findIndex((x) => String(x.id) === String(id));
      if (i === -1) return false;
      d.orgs.splice(i, 1);
      d.members = d.members.filter((m) => String(m.org_id) !== String(id));
      await save();
      return true;
    },
    async count() {
      const d = await load();
      return d.orgs.length;
    },
    async memberCount(orgId) {
      const d = await load();
      return d.members.filter((m) => String(m.org_id) === String(orgId)).length;
    },
    async membersOf(orgId) {
      const d = await load();
      return d.members.filter((m) => String(m.org_id) === String(orgId)).map(mapMember);
    },
    async orgsOf(userId) {
      const d = await load();
      return d.members.filter((m) => String(m.user_id) === String(userId)).map(mapMember);
    },
    async setMember(userId, orgId, role) {
      const d = await load();
      const m = d.members.find(
        (x) => String(x.user_id) === String(userId) && String(x.org_id) === String(orgId)
      );
      if (m) {
        m.role = role || m.role || 'reporter';
        await save();
        return mapMember(m);
      }
      const rec = {
        user_id: userId,
        org_id: orgId,
        role: role || 'reporter',
        created_at: new Date().toISOString(),
      };
      d.members.push(rec);
      await save();
      return mapMember(rec);
    },
    async removeMember(userId, orgId) {
      const d = await load();
      const before = d.members.length;
      d.members = d.members.filter(
        (m) => !(String(m.user_id) === String(userId) && String(m.org_id) === String(orgId))
      );
      await save();
      return before !== d.members.length;
    },
    async allMembers() {
      const d = await load();
      return d.members.map(mapMember);
    },
  };
}
