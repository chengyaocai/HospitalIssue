// 统一 500 出口：原始错误（含英文的 mssql 驱动报错）只进日志，
// 对外一律中文；仓储层已包装的中文错误（如「数据库连接失败…」）原样透出。
const KNOWN_ZH_ERRORS = ['数据库连接失败'];

export function send500(res, e) {
  console.error('[api]', e && e.stack ? e.stack : e);
  const msg = (e && e.message) || '';
  const error = KNOWN_ZH_ERRORS.some((k) => msg.includes(k))
    ? msg
    : '服务器内部错误，请稍后重试或联系管理员';
  res.status(500).json({ error });
}

// 带业务状态码的错误出口（e.status 为 4xx 时透传其 message，5xx 统一中文）
export function sendError(res, e) {
  const status = (e && e.status) || 500;
  if (status < 500) return res.status(status).json({ error: (e && e.message) || '请求失败' });
  send500(res, e);
}
