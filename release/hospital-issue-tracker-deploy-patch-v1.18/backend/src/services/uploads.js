import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';

fs.mkdirSync(config.uploadsDir, { recursive: true });

// —— 中文文件名乱码修复（v1.18.5）——
// 起因：multipart 的 Content-Disposition 里 filename 由 busboy 按 **latin1** 解码
// （busboy 的 defParamCharset 默认值就是 latin1），而浏览器发的是 UTF-8 字节，
// 于是「会议纪要.pdf」在 req.file.originalname 里变成「ä¼šè®®çºªè¦.pdf」。
// 两道处理：
//   ① 源头：给 multer 传 defParamCharset:'utf8'（multer 会把该选项透传给 busboy）→ 新上传不再乱码；
//   ② 兜底：repairMojibakeName() 把「已被 latin1 误解码」的字符串按字节还原，
//      供历史存量数据、以及不按 UTF-8 发文件名客户端使用。两个上传路由都先用它再落库。
// 该函数幂等：正确的文件名（纯 ASCII 或合法 UTF-8）原样返回，不会二次破坏。
// ⚠️ 前端 frontend/src/api.js 有一份语义完全相同的实现（浏览器无 Buffer），改动请同步两处。
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

export function repairMojibakeName(name) {
  if (typeof name !== 'string' || !name) return name;
  // 纯 ASCII：不可能是 latin1 误解码的产物，直接放过（绝大多数文件名走这条快路径）
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  try {
    // latin1 解码等价于「逐字符取低 8 位」→ 还原出 busboy 当时真正读到的字节
    const bytes = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i += 1) bytes[i] = name.charCodeAt(i) & 0xff;
    const fixed = utf8Fatal.decode(bytes);
    return fixed && fixed !== name ? fixed : name;
  } catch {
    // 不是合法 UTF-8 字节序列（例如真正的 latin1/GBK 文件名）→ 保持原样，避免越修越坏
    return name;
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(repairMojibakeName(file.originalname)) || '';
    const safe = crypto.randomBytes(12).toString('hex') + ext;
    cb(null, safe);
  },
});

// 单文件上传，限制 20MB
export const upload = multer({
  storage,
  // 中文文件名必须显式声明 UTF-8，否则被 latin1 解码成乱码（详见上方说明）
  defParamCharset: 'utf8',
  limits: { fileSize: 20 * 1024 * 1024 },
});

// 删除问题记录时一并清理磁盘上的附件文件，避免产生孤儿文件。
// 只取 basename，防止 storedName 被构造成路径穿越。
export async function removeStoredFiles(attachments = []) {
  let removed = 0;
  for (const a of attachments || []) {
    const name = a && a.storedName ? path.basename(String(a.storedName)) : '';
    if (!name) continue;
    try {
      await fs.promises.unlink(path.join(config.uploadsDir, name));
      removed++;
    } catch { /* 文件不存在等情况直接忽略 */ }
  }
  return removed;
}
