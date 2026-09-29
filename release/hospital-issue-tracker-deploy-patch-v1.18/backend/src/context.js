import { AsyncLocalStorage } from 'node:async_hooks';

// 请求级上下文（Node AsyncLocalStorage）。
// 目的：让「审计日志」这类在深层调用链中被调用的通用函数，能自动带上当前请求的机构，
// 而无需在 30+ 处 audit() 调用点逐一传参（少传一处就会漏掉机构归属）。
// 注意：仅用于「读取当前请求上下文」，业务数据隔离仍以显式的 orgId 参数为准（可测、可追溯）。
const als = new AsyncLocalStorage();

export function runWithContext(ctx, fn) {
  return als.run(ctx || {}, fn);
}

// 当前请求的机构 id；无上下文（如启动期任务）返回 null。
export function currentOrgId() {
  const s = als.getStore();
  return s && s.orgId != null ? s.orgId : null;
}

// 当前请求的登录账号；无上下文返回 null。
export function currentUsername() {
  const s = als.getStore();
  return s && s.username ? s.username : null;
}
