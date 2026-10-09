// 在本机（授权机器）上把 backend/src 全部 .js 加密为同名 .js.enc。
// 必须在「部署目标机器」上执行 —— 密文与本机指纹绑定，拷到别处无法解密。
//
// 用法（cwd = 项目根 或 backend/ 均可，脚本按自身位置定位 src）：
//   node backend/tools/encrypt-src.mjs            # 生成 .enc，保留明文 .js（安全过渡，可回退）
//   node backend/tools/encrypt-src.mjs --purge    # 生成 .enc 后删除明文 .js（部署终态：磁盘上只有密文）
//   node backend/tools/encrypt-src.mjs --check    # 校验全部 .enc 能在本机解密（不解压、不落盘）
//
// 解密由运行时 loader 完成，明文仅在进程内存中存在，绝不写回磁盘。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineId } from './machine-id.mjs';
import { deriveKey, encryptSource, decryptSource } from './crypto-shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src');
const args = new Set(process.argv.slice(2));
const mode = args.has('--check') ? 'check' : args.has('--purge') ? 'purge' : 'encrypt';
const mid = machineId();
const key = deriveKey(mid);

let count = 0;
let failed = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!entry.name.endsWith('.js') || entry.name.endsWith('.enc')) continue;
    const enc = p + '.enc';
    if (mode === 'check') {
      try { decryptSource(fs.readFileSync(enc), key); count++; }
      catch { failed++; console.error('  校验失败(指纹不符/损坏):', path.relative(SRC, enc)); }
      continue;
    }
    const plain = fs.readFileSync(p);
    fs.writeFileSync(enc, encryptSource(plain, key));
    count++;
    if (mode === 'purge') fs.rmSync(p);
  }
}

console.log(`加密范围 : ${SRC}`);
console.log(`本机指纹 : ${mid}`);
console.log(`模式     : ${mode === 'check' ? '仅校验本机可解密' : mode === 'purge' ? '加密并删除明文 .js' : '加密(保留明文 .js 以便回退)'}`);

if (!fs.existsSync(SRC)) {
  console.error('未找到 backend/src，请确认在正确目录下执行。');
  process.exit(2);
}

walk(SRC);

if (mode === 'check') {
  console.log(`校验结果 : 通过 ${count} / 失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}
console.log(`已生成 .enc: ${count} 个` + (mode === 'purge' ? '（并已删除同名明文 .js）' : '（明文 .js 仍保留，确认无误后执行 --purge）'));
console.log('启动: node --import ./backend/loader.mjs backend/start-enc.mjs （从项目根执行）');
