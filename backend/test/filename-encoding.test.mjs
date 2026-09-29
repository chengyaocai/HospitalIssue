// 上传文件名编码测试（静态为主，无需起服务）。
//
// 为什么需要它：multipart 的 filename 由 busboy 按 **latin1** 解码（defParamCharset 默认值），
// 而浏览器发的是 UTF-8 字节 → 中文文件名落库即乱码（v1.18.5 修的就是这个）。
// 修法有两处、必须成对存在，任何一处被删掉都会重新乱码：
//   ① 源头：backend/src/services/uploads.js 给 multer 传 defParamCharset:'utf8'（透传给 busboy）；
//   ② 兜底：repairMojibakeName() 把已被 latin1 误解码的字符串按字节还原 ——
//      后端一份（uploads.js，Node 用 TextDecoder）、前端一份（api.js，浏览器同样用 TextDecoder），
//      另加前端 repairNames()：在唯一的 JSON 出口对存量坏数据做显示层兜底。
//      本测试用同一张用例表分别喂给两份实现，逐步比对结果，防止「只改一边」。
//
// 运行：cd backend && node test/filename-encoding.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(path.resolve(__dirname, rel)).href);
const read = (rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

const beMod = await imp('../src/services/uploads.js');            // 后端实现
const feMod = await imp('../../frontend/src/api.js');             // 前端实现
const beFix = beMod.repairMojibakeName;
const feFix = feMod.repairMojibakeName;
const feRepairNames = feMod.repairNames;

const uploadsSrc = read('../src/services/uploads.js');
const attachSrc = read('../src/routes/attachments.js');
const chatSrc = read('../src/routes/chat.js');

let passed = 0;
let failed = 0;
function assert(cond, msg, extra = '') {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg + (extra ? ' :: ' + extra : '')); }
}

// 「真实乱码串」：busboy 1.6.0 在默认 defParamCharset 下对 UTF-8「会议纪要2026.pdf」的实际产物。
// 这里逐码点写死（U+00E4 U+00BC U+009A U+00E8 U+00AE U+00AE U+00E7 U+00BA U+00AA U+00E8 U+00A6 U+0081），
// 断言的是「真实世界里出现过的产物」，而不是从正确名字反推出来的等价物。
const CN = '会议纪要2026.pdf';
const MOJIBAKE = '\u00e4\u00bc\u009a\u00e8\u00ae\u00ae\u00e7\u00ba\u00aa\u00e8\u00a6\u0081' + '2026.pdf';
// latin1 误解码的生成式（等价于 busboy 当时做的事），用于往返性质测试
const toMojibake = (correct) => Buffer.from(correct, 'utf8').toString('latin1');

console.log('\n== 1) 前提校验：乱码串确实是「UTF-8 字节被 latin1 解码」 ==');
assert(MOJIBAKE !== CN, '乱码串与正确名不同');
assert(Buffer.from(MOJIBAKE, 'latin1').toString('utf8') === CN, '乱码串按 latin1 取字节后能按 UTF-8 解回中文名');
assert([...MOJIBAKE].some((c) => c.codePointAt(0) >= 0x80 && c.codePointAt(0) <= 0xff),
  '乱码串含 U+0080–U+00FF 区间的字符（触发修复的判据）');
assert(!/[\u0080-\u00ff]/.test(CN), '正确的中文名不含 U+0080–U+00FF 区间字符（不会误判为乱码）');

// 手工可核对的用例表：[输入, 期望输出, 说明]
const CASES = [
  [MOJIBAKE, CN, '真实乱码串 → 还原为中文名'],
  ['\u00e4\u00bc\u009a\u00e8\u00ae\u00ae\u00e7\u00ba\u00aa\u00e8\u00a6\u0081.docx', '会议纪要.docx', '同乱码不同扩展名同样还原'],
  [CN, CN, '已正确的中文名 → 原样不动（幂等）'],
  ['HIS故障清单.xlsx', 'HIS故障清单.xlsx', '中英混排正确名 → 原样不动'],
  ['note.txt', 'note.txt', '纯 ASCII → 原样不动'],
  ['a.b.c.tar.gz', 'a.b.c.tar.gz', '多点号 ASCII → 原样不动'],
  ['', '', '空串 → 原样返回'],
  [null, null, 'null → 原样返回'],
  [undefined, undefined, 'undefined → 原样返回'],
  [12345, 12345, '非字符串 → 原样返回'],
  ['\u00a9.pdf', '\u00a9.pdf', '孤立续接字节（非法 UTF-8）→ 拒绝修复，避免越修越坏'],
  ['caf\u00e9.pdf', 'caf\u00e9.pdf', '本就正确的 Latin-1 重音名（其字节非法 UTF-8）→ 原样不动'],
  ['\u00c3\u00a9.pdf', '\u00e9.pdf', 'Latin-1 重音名的乱码 → 还原（已知取舍，见文件末说明）'],
  ['abc\u0000def', 'abc\u0000def', '含 NUL 的异常名（字节含 0x00）→ 不炸、不强改'],
];

console.log('\n== 2) 后端实现 (services/uploads.js) ==');
for (const [input, want, desc] of CASES) {
  const got = beFix(input);
  assert(Object.is(got, want), desc, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
}

console.log('\n== 3) 前端实现 (api.js) 与后端逐用例一致 ==');
for (const [input, want, desc] of CASES) {
  const got = feFix(input);
  assert(Object.is(got, want), '前端 ' + desc, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  assert(Object.is(got, beFix(input)), '前后端结果一致：' + desc);
}

console.log('\n== 4) 往返性质：一批真实文件名乱码后必须还原 ==');
const REAL_NAMES = [
  '会议纪要2026.pdf', 'HIS故障清单.xlsx', '关键运维系统.docx', '2024年报表.xlsx',
  '医保接口字段说明（V3）.doc', '住院结算差额排查记录.docx', '内网IP端口分配表.xlsx',
  '关于门诊叫号系统异常的情况说明.pdf', 'EMPI患者主索引-同步失败截图.png',
  '数据库备份_20260923.zip', 'A', '.pdf', ' 会议纪要.pdf',
];
for (const name of REAL_NAMES) {
  const moji = toMojibake(name);
  assert(beFix(moji) === name, `后端往返还原：${name}`,
    `得到 ${JSON.stringify(beFix(moji))}`);
  assert(feFix(moji) === name, `前端往返还原：${name}`,
    `得到 ${JSON.stringify(feFix(moji))}`);
  assert(beFix(name) === name && feFix(name) === name, `对正确名幂等：${name}`);
}

console.log('\n== 5) 幂等与解码器稳定性 ==');
const plainObj = {};
assert(beFix(plainObj) === plainObj && feFix(plainObj) === plainObj, '对象输入原样返回（同一引用，不做深拷贝）');
const arrIn = [];
assert(beFix(arrIn) === arrIn && feFix(arrIn) === arrIn, '数组输入原样返回（同一引用）');
assert(beFix(beFix(MOJIBAKE)) === CN, '后端二次处理不产生新变化（幂等）');
assert(feFix(feFix(MOJIBAKE)) === CN, '前端二次处理不产生新变化（幂等）');
// 共享的 fatal 解码器：抛错后必须仍能正常工作
assert(beFix('\u00a9.pdf') === '\u00a9.pdf' && beFix(CN) === CN && beFix(MOJIBAKE) === CN,
  '后端共享解码器在「非法输入抛错」后仍能正确处理后续输入');
assert(feFix('\u00a9.pdf') === '\u00a9.pdf' && feFix(CN) === CN && feFix(MOJIBAKE) === CN,
  '前端共享解码器在「非法输入抛错」后仍能正确处理后续输入');
assert(Buffer.byteLength(beFix(MOJIBAKE), 'utf8') === Buffer.byteLength(CN, 'utf8'),
  '还原结果的 UTF-8 字节数与正确名一致（不是截断/替换产物）');
assert(!beFix(MOJIBAKE).includes('\uFFFD') && !feFix(MOJIBAKE).includes('\uFFFD'),
  '还原结果不含替换字符 U+FFFD');

console.log('\n== 6) 源头修复：multer 必须显式声明 UTF-8 ==');
assert(/defParamCharset:\s*'utf8'/.test(uploadsSrc), "uploads.js 的 multer 选项含 defParamCharset: 'utf8'");
assert(!/defParamCharset:\s*'latin1'/.test(uploadsSrc), 'uploads.js 未把 defParamCharset 设回 latin1');
assert(/export function repairMojibakeName/.test(uploadsSrc), 'uploads.js 导出了 repairMojibakeName');
assert(/path\.extname\(repairMojibakeName\(file\.originalname\)\)/.test(uploadsSrc),
  '磁盘落盘扩展名也取自「修复后」的文件名（否则扩展名一起乱码）');
assert(/originalName:\s*\n?\s*originalName|originalName,\s*\n\s*storedName/.test(attachSrc),
  'attachments.js 落库使用清洗后的 originalName');

console.log('\n== 7) 两个上传路由都做了落库前清洗 ==');
assert(/repairMojibakeName\(req\.file\.originalname\)/.test(attachSrc), 'attachments.js 调用了 repairMojibakeName');
assert(!/originalName: req\.file\.originalname/.test(attachSrc), 'attachments.js 不再直接落库原始（可能乱码）的 originalname');
assert(/res\.download\(.*repairMojibakeName\(att\.originalName\)/.test(attachSrc),
  'attachments.js 下载时 Content-Disposition 的文件名也做了清洗');
assert(!/detail: req\.file\.originalname/.test(attachSrc), 'attachments.js 操作日志不再记录乱码文件名');

assert(/repairMojibakeName\(req\.file\.originalname\)/.test(chatSrc), 'chat.js 调用了 repairMojibakeName');
assert(!/originalName: req\.file\.originalname/.test(chatSrc), 'chat.js 不再直接落库原始 originalname');
assert(/repairMojibakeName\(String\(\(a && a\.originalName\)/.test(chatSrc),
  'chat.js 的 sanitizeAttachments 对客户端传来的文件名同样清洗（防止绕过）');

console.log('\n== 8) 前端：显示层兜底（存量数据） ==');
assert(typeof feRepairNames === 'function', 'api.js 导出了 repairNames');
assert(typeof feFix === 'function', 'api.js 导出了 repairMojibakeName');
assert(/return repairNames\(data\)/.test(read('../../frontend/src/api.js')),
  'api.js 的唯一 JSON 出口 req() 调用了 repairNames（一处覆盖全部渲染点）');

const legacy = {
  total: 1,
  rows: [{
    id: 7, title: '打印机故障',
    attachments: [
      { id: 'a1', originalName: MOJIBAKE, storedName: 'deadbeefdeadbeefdeadbeef.pdf', size: 12 },
      { id: 'a2', originalName: 'ok.txt', storedName: 'aabbccaabbccaabbccaabbcc.txt', size: 3 },
    ],
  }],
};
const fixed = feRepairNames(legacy);
assert(fixed.rows[0].attachments[0].originalName === CN, '嵌套数组里的 originalName 被还原');
assert(fixed.rows[0].attachments[1].originalName === 'ok.txt', '正常文件名不受影响');
assert(fixed.rows[0].title === '打印机故障', '其它字段不被改动');
assert(fixed.rows[0].attachments[0].storedName === 'deadbeefdeadbeefdeadbeef.pdf', 'storedName 不被改动');
assert(fixed.rows[0].id === 7 && fixed.total === 1, '结构与非字符串字段保持不变');

const chatMsg = feRepairNames({ user: { attachments: [{ originalName: toMojibake('内网IP端口分配表.xlsx') }] } });
assert(chatMsg.user.attachments[0].originalName === '内网IP端口分配表.xlsx', '聊天消息附件名被还原');

const audit = feRepairNames([{ id: 1, action: 'UPLOAD_ATTACHMENT', detail: MOJIBAKE }]);
assert(audit[0].detail === CN, '操作日志 detail 里的乱码文件名同样还原');
assert(feRepairNames(null) === null && feRepairNames(undefined) === undefined, 'null/undefined 安全返回');
assert(feRepairNames('text') === 'text' && feRepairNames(5) === 5, '原始值输入原样返回');
assert(JSON.stringify(feRepairNames([])) === '[]' && JSON.stringify(feRepairNames({})) === '{}', '空容器安全');
// 合理嵌套深度内必须还原；超过深度上限则停止深入（防止病态/超深结构拖垮渲染）
const shallow = {};
let sCur = shallow;
for (let i = 0; i < 5; i += 1) { sCur.n = {}; sCur = sCur.n; }
sCur.originalName = MOJIBAKE;
feRepairNames(shallow);
assert(sCur.originalName === CN, '合理嵌套深度（5 层）内正常还原');

const deepObj = {};
let dCur = deepObj;
for (let i = 0; i < 12; i += 1) { dCur.n = {}; dCur = dCur.n; }
dCur.originalName = MOJIBAKE;
feRepairNames(deepObj);
assert(dCur.originalName === MOJIBAKE, '超过深度上限（12 层）后不再深入，原样保留');
const cyc = { originalName: 'x.txt' };
cyc.self = cyc;
let cycOk = true;
try { feRepairNames(cyc); } catch { cycOk = false; }
assert(cycOk, '自引用对象不抛栈溢出（深度上限兜底）');
assert(cyc.originalName === 'x.txt', '自引用对象里的正常文件名不受影响');

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);

// 已知取舍：修复判据是「含 U+0080–U+00FF 的字符 + 这些字符的低 8 位构成合法 UTF-8 序列」。
// 唯一会误伤的情况是文件名**字面量**就是一段「像 latin1 乱码的字符」（例如真的叫 `Ã©.pdf`），
// 实际业务中不可能出现；换来的是无需配置即可修复全部 CJK / 带重音的存量文件名。
