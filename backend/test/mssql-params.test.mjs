// mssql 参数注册静态核查：同一 sql.Request 实例上不得重复注册同名 @param。
// 背景：tedious 会抛「The parameter name X has already been declared」，而 dev(JSON) 驱动测不出来，
// 且本机无 SQL Server 实例 —— 新增/修改任何 mssql 存储方法后，务必跑一次本检查。
//
// 判定模型：按 .input() 的【接收者变量】分组，该变量被重新赋值（新实例）即重置生命周期；
//           形如 p.request() / new sql.Request(tx) 的接收者，每次调用视为新实例。
// 另外列出「helper 内部注册了 @org/@user」的函数，提示调用方不得在同一 req 上再注册同名参数。
//
// 用法：cd backend && node test/mssql-params.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.js$/.test(e.name) && /(mssql|Repo)/i.test(e.name)) out.push(p);
  }
  return out;
}

const INPUT_RE = /([A-Za-z_$][\w$]*(?:\.request\(\))?)\s*\.input\(\s*['"]([A-Za-z_$][\w$]*)['"]/g;
const ASSIGN_RE = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?!=[=])/g;
const RESERVED = new Set(['const', 'let', 'var', 'return', 'if', 'while', 'for', 'of', 'in', 'typeof', 'await']);

let pass = 0;
let fail = 0;
const suspects = [];

function judge(name, ok, extra = '') {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

for (const file of walk(root)) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const live = new Map();       // recv -> Map(param -> lineNo)
  let holder = '(root)';
  const dups = [];

  lines.forEach((line, i) => {
    const ln = i + 1;
    const fn = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/.exec(line);
    if (fn) holder = fn[1];

    let a;
    ASSIGN_RE.lastIndex = 0;
    while ((a = ASSIGN_RE.exec(line)) !== null) {
      const v = a[1];
      if (!RESERVED.has(v)) live.delete(v);
    }

    const lineRecv = new Set();
    let g;
    INPUT_RE.lastIndex = 0;
    while ((g = INPUT_RE.exec(line)) !== null) {
      const recv = g[1];
      const name = g[2];
      if (/\.request\(\)$/.test(recv) && !lineRecv.has(recv)) live.delete(recv);
      lineRecv.add(recv);
      if (!live.has(recv)) live.set(recv, new Map());
      const m = live.get(recv);
      if (m.has(name)) dups.push(`${holder}() ${recv}.input('${name}') 行 ${m.get(name)} 与 ${ln}`);
      else m.set(name, ln);
    }
  });

  judge(`${rel} 无同实例重复注册`, dups.length === 0, dups.join(' / '));

  const txt = lines.join('\n');
  for (const m of txt.matchAll(/(?:function|const)\s+(\w+)\s*[=]?\s*\(?[^)]*\)?\s*[^{]*\{\s*[^}]*?\.input\(\s*['"](org|user)['"]/gs)) {
    suspects.push(`${rel} :: ${m[1]}() 内部注册了 @${m[2]}（调用方不得在同一 req 上再注册同名参数）`);
  }
}

judge('存在 mssql 存储文件可扫描', pass + fail > 1);

console.log('\n--- helper 提醒（人工确认用，不算失败）---');
for (const s of new Set(suspects)) console.log('  · ' + s);

console.log(`\nRESULT: passed=${pass} failed=${fail}`);
process.exit(fail === 0 ? 0 : 1);
