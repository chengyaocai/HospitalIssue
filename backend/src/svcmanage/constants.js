// 业务服务管理（v1.18.82）共享常量：服务类型 / 运行环境。
// 存储层与路由层共用；前端下拉通过 GET /api/services 的 meta 随响应下发（同源渲染，避免两处维护）。

// 服务类型（下拉固定表；未知值归一化为「未指定」）
export const SVC_TYPES = ['未指定', '网站应用', '接口服务', '数据库', '中间件', '文件服务', '客户端', '其他'];

// 运行环境（下拉固定表；未知值归一化为「未指定」）
export const SVC_ENVS = ['未指定', '生产', '灰度', '测试', '开发'];

export function normalizeSvcType(v) {
  const s = String(v || '').trim();
  return SVC_TYPES.includes(s) ? s : '未指定';
}

export function normalizeSvcEnv(v) {
  const s = String(v || '').trim();
  return SVC_ENVS.includes(s) ? s : '未指定';
}
