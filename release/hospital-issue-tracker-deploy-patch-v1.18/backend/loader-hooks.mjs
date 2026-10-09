// ESM 加载钩子：对 backend/src 下的 .js，若存在同名 .js.enc 则在内存解密后返回源码（明文永落盘）；
// 若同时存在明文 .js（开发 / 明文部署）则正常加载，不作干预；node_modules 等其它文件一律不碰。
// 解密失败（机器指纹不符 / 文件被篡改）→ 返回一个「立即抛错」的模块源码，使启动直接失败并给出清晰提示。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineId } from './tools/machine-id.mjs';
import { deriveKey, decryptSource } from './tools/crypto-shared.mjs';

const SRC_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', 'src');

let KEY = null;
try { KEY = deriveKey(machineId()); } catch { KEY = null; }

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const p = fileURLToPath(url);
    if (p.startsWith(SRC_ROOT)) {
      const enc = p + '.enc';
      if (fs.existsSync(enc)) {
        if (!KEY) {
          return { format: 'module', shortCircuit: true, source: 'throw new Error("无法获取本机指纹，已拒绝启动(ENCRYPT_LOADER)");' };
        }
        try {
          const src = decryptSource(fs.readFileSync(enc), KEY).toString('utf8');
          return { format: 'module', shortCircuit: true, source: src };
        } catch (e) {
          return {
            format: 'module',
            shortCircuit: true,
            source: `throw new Error("后端源码解密失败：本机指纹不匹配或文件被篡改，已拒绝启动 (${e.message})");`,
          };
        }
      }
    }
  }
  return next(url, context);
}
