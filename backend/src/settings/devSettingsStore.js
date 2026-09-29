import fs from 'node:fs/promises';
import path from 'node:path';

// dev / 测试用：本地 JSON 文件系统设置。
// 单机构（旧）形态：键值直接平铺在文件根对象上。
// 多机构（v1.18）形态：机构级设置挂在 __orgs[orgId] 下，根层仍保留全局（遗留）键。
const ORG_KEY = '__orgs';

export function createDevSettingsStore(filePath) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      cache = {};
      await fs.writeFile(filePath, '{}', 'utf8');
    }
    // 防御：文件内容非对象（如 null / 数组）时回落为空对象。
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
    return cache;
  }

  async function save(data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    cache = data;
  }

  return {
    // orgId 缺省（null/undefined）= 读取遗留的全局设置；否则读取该机构自己的设置。
    async get(orgId) {
      const data = await load();
      if (orgId == null) return { ...data };
      const bucket = data[ORG_KEY] || {};
      return { ...(bucket[String(orgId)] || {}) };
    },
    async update(patch, orgId) {
      const data = await load();
      if (orgId == null) {
        // 全局分支：与 __orgs 互不影响（patch 的键都是业务设置键）。
        const merged = { ...data, ...patch };
        await save(merged);
        return { ...merged };
      }
      const bucket = { ...(data[ORG_KEY] || {}) };
      const key = String(orgId);
      bucket[key] = { ...(bucket[key] || {}), ...patch };
      const next = { ...data, [ORG_KEY]: bucket };
      await save(next);
      return { ...bucket[key] };
    },
  };
}
