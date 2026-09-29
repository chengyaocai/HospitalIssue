import { config } from '../config.js';
import { createDevAuditStore } from './devAuditStore.js';
import { createMssqlAuditStore } from './mssqlAuditStore.js';
import { currentOrgId } from '../context.js';

let store;

export async function getAuditStore() {
  if (store) return store;
  store = config.dbDriver === 'dev'
    ? createDevAuditStore(config.auditDevPath)
    : createMssqlAuditStore(config.mssql);
  return store;
}

// 记录审计日志；失败不影响主流程。
// 机构归属（v1.18）：优先取 event.orgId，缺省自动取当前请求上下文（authenticate 注入），
// 因此在各路由/服务里调用 audit() 无需逐一传参；无上下文时落默认机构。
export async function audit(event) {
  try {
    const s = await getAuditStore();
    const orgId = event && event.orgId != null ? event.orgId : currentOrgId();
    await s.add({ ...event, org_id: orgId });
  } catch (e) {
    console.error('audit error:', e.message);
  }
}
