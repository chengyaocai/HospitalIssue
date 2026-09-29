// 工时工作知识库（v1.18.42 原生集成）：存于 Configs/timesheet-kb.json，JSON 字符串数组。
// 对齐 WXP AISkillController.TimesheetKb*：读失败返回空列表；新增 trim + 500 字截断；删除按索引越界报错。

import fs from 'node:fs';
import path from 'node:path';
import { timesheetConfigDir } from './configs.js';

function kbPath() {
  return path.join(timesheetConfigDir, 'timesheet-kb.json');
}

export function loadKb() {
  const p = kbPath();
  if (!fs.existsSync(p)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => x.trim());
  } catch {
    return [];
  }
}

function saveKb(items) {
  fs.mkdirSync(timesheetConfigDir, { recursive: true });
  fs.writeFileSync(kbPath(), JSON.stringify(items, null, 2), 'utf8');
}

export function kbAll() {
  const items = loadKb();
  return { success: true, total: items.length, items };
}

export function kbRandom(count = 3) {
  const items = loadKb();
  if (items.length === 0) return { success: true, total: 0, items: [] };
  const n = Math.max(1, Math.min(count <= 0 ? 3 : count, items.length));
  const pool = [...items].sort(() => Math.random() - 0.5).slice(0, n);
  return { success: true, total: pool.length, items: pool };
}

export function kbAdd(content) {
  let c = String(content || '').trim();
  if (!c) return { success: false, message: '内容不能为空' };
  if (c.length > 500) c = c.slice(0, 500);
  const items = loadKb();
  items.push(c);
  saveKb(items);
  return { success: true, total: items.length, message: '已添加' };
}

export function kbDelete(index) {
  if (!Number.isInteger(index) || index < 0) return { success: false, message: '参数错误' };
  const items = loadKb();
  if (index >= items.length) return { success: false, message: '索引越界，可能已被删除' };
  items.splice(index, 1);
  saveKb(items);
  return { success: true, total: items.length, message: '已删除' };
}
