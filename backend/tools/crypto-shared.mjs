// 加解密核心（加密工具与运行时 loader 共用，必须逐字一致）。
// 算法：AES-256-GCM；密钥 = scrypt(本机指纹, PEPPER, 32)。
// 密文布局：iv(12) | authTag(16) | ciphertext。GCM 校验失败即抛错 —— 机器不符 / 文件被篡改都会被拒。
import crypto from 'node:crypto';

// ⚠️ 编译期常量（PEPPER）：与 loader 必须逐字一致；更换它需在本机重新加密（全体重绑）。
// 它是「本地加密串」的盐：单独拿到它也无法解密，必须结合本机指纹。请按机构自行替换为私有值。
export const PEPPER = 'e7c2a9f14b3d8e6f0a5c1b9d7e2f4a8c3b6d0e9f1a2c4b7d5e8f0a3c6b9d2e5';

const ALGO = 'aes-256-gcm';

export function deriveKey(machineId) {
  // scrypt 默认参数 N=16384/r=8/p=1，足够；一次性派生，开销可接受。
  return crypto.scryptSync(String(machineId), PEPPER, 32);
}

// plaintext: Buffer → 返回 Buffer(iv|tag|ct)
export function encryptSource(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

// buf: Buffer(iv|tag|ct) → 返回明文 Buffer（校验失败抛错，绝不返回半成品明文）
export function decryptSource(buf, key) {
  if (!Buffer.isBuffer(buf) || buf.length < 28) throw new Error('ENCRYPTED_FILE_INVALID');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
