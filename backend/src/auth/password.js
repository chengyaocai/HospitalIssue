import crypto from 'node:crypto';

// 使用 Node 内置 crypto.scrypt 做密码哈希，避免引入原生编译依赖（如 bcrypt）。
// v1.6：由同步 scryptSync 改为异步 crypto.scrypt（Promise 包装），避免登录/建用户时阻塞事件循环；
// 参数保持完全一致（随机 16 字节 salt、keylen 64、默认 N/r/p），存量口令哈希全部兼容。

// 把回调式 crypto.scrypt 包装成 Promise（参数与原 scryptSync 完全一致）
function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const derived = await scryptAsync(password, salt, 64);
  const a = derived;
  const b = Buffer.from(key, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
