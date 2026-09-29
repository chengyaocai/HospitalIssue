// 权限模型一致性测试（静态，无需起服务）。
//
// 为什么需要它：前端 api.js 与后端 permissions.js 是「同一份权限目录的两份拷贝」，
// 靠人工同步 —— 历史上反复出现「只改了一边」的问题（菜单/功能 key 对不上，
// 界面勾了不生效、或后端拒绝前端放行）。本测试把这条规则固化成断言，改一边不改另一边就红。
//
// 另含一条安全不变量：平台级功能（如「机构管理」）绝不允许出现在机构角色权限目录里。
// 角色是按机构存储的（app_org_setting），而机构管理是跨机构操作；
// 一旦它变成可勾选的机构角色权限，A 机构的管理员就能管 B 机构 —— 跨机构越权。
//
// 运行：cd backend && node test/perm-model.test.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(path.resolve(__dirname, rel)).href);

const be = await imp('../src/permissions.js');          // 后端权限目录
const exp = await imp('../src/services/export.js');      // 后端导出「操作」中文名
const fe = await imp('../../frontend/src/api.js');       // 前端权限目录 / 操作中文名

let passed = 0;
let failed = 0;
function assert(cond, msg, extra = '') {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg + (extra ? ' :: ' + extra : '')); }
}

// 逐项比对两个 {key,label[,menu]} 列表：顺序、key、label（以及可选 menu）都要一致。
function sameCatalog(name, a, b, fields) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    assert(false, `${name} 两侧都是数组`, `后端=${Array.isArray(a)} 前端=${Array.isArray(b)}`);
    return;
  }
  assert(a.length === b.length, `${name} 条目数一致（后端 ${a.length} / 前端 ${b.length}）`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const [x, y] = [a[i], b[i]];
    const f = fields.find((k) => String(x?.[k]) !== String(y?.[k]));
    assert(!f, `${name}[${i}] 「${x?.key ?? '?'}」的 ${f || '全部字段'} 一致`,
      f ? `后端=${JSON.stringify(x?.[f])} 前端=${JSON.stringify(y?.[f])}` : '');
  }
}

try {
  console.log('--- 菜单 / 功能 / 模块目录（permissions.js ↔ api.js 逐字一致）---');
  sameCatalog('MENUS', be.MENUS, fe.PERM_MENUS, ['key', 'label']);
  sameCatalog('ACTIONS', be.ACTIONS, fe.PERM_ACTIONS, ['key', 'label', 'menu']);
  sameCatalog('PERM_MODULES', be.PERM_MODULES, fe.PERM_MODULES, ['key', 'label']);
  sameCatalog('PLATFORM_MODULES', be.PLATFORM_MODULES, fe.PLATFORM_MODULES, ['key', 'label', 'desc']);

  console.log('--- 操作日志中文名（services/export.js ↔ api.js）---');
  const beLabels = exp.ACTION_LABELS || {};
  const feLabels = fe.ACTION_LABELS || {};
  const beKeys = Object.keys(beLabels).sort();
  const feKeys = Object.keys(feLabels).sort();
  assert(beKeys.join(',') === feKeys.join(','), 'ACTION_LABELS 的 key 集合一致',
    `后端独有=${beKeys.filter((k) => !feKeys.includes(k)).join('|') || '无'}；前端独有=${feKeys.filter((k) => !beKeys.includes(k)).join('|') || '无'}`);
  const mismatched = beKeys.filter((k) => feKeys.includes(k) && beLabels[k] !== feLabels[k]);
  assert(mismatched.length === 0, 'ACTION_LABELS 的中文名逐字一致',
    mismatched.map((k) => `${k}: 后端=${beLabels[k]} 前端=${feLabels[k]}`).join('；'));

  console.log('--- 安全不变量：平台级功能不可落入机构角色权限 ---');
  const platKeys = (be.PLATFORM_MODULES || []).map((m) => m.key);
  assert(platKeys.length > 0, 'PLATFORM_MODULES 非空');
  assert(platKeys.every(Boolean), 'PLATFORM_MODULES 的 key 均非空');
  assert(platKeys.includes('orgs'), '平台级功能清单含 orgs（机构管理）');

  const menuKeys = (be.MENUS || []).map((m) => m.key);
  const permModKeys = (be.PERM_MODULES || []).map((m) => m.key);
  for (const k of platKeys) {
    assert(!menuKeys.includes(k), `平台级「${k}」不在 MENUS 中（否则可被按机构角色授权 -> 跨机构越权）`);
    assert(!permModKeys.includes(k), `平台级「${k}」不在 PERM_MODULES 中（弹框左栏不可出现可勾选开关）`);
    assert(!(be.ACTIONS || []).some((a) => a.menu === k), `无任何 ACTION 挂到平台级「${k}」下`);
  }

  console.log('--- 兜底：机构管理在导航中仍由平台管理员标识控制 ---');
  // 前端 api.js 不应把 orgs 混进任何「机构角色权限」相关清单
  assert(!(fe.PERM_MENUS || []).some((m) => m.key === 'orgs'), '前端 PERM_MENUS 不含 orgs');
  assert(!(fe.PERM_MODULES || []).some((m) => m.key === 'orgs'), '前端 PERM_MODULES 不含 orgs');
  assert((fe.PLATFORM_MODULES || []).some((m) => m.key === 'orgs'), '前端 PLATFORM_MODULES 含 orgs');
} catch (e) {
  failed++;
  console.error('  FAIL 异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
}

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
