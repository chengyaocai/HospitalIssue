export const TYPES = ['故障', '需求', '咨询', '其他'];
export const SEVERITIES = ['低', '中', '高', '紧急'];
export const STATUSES = ['待处理', '处理中', '已解决', '已关闭'];
export const SATISFACTIONS = ['满意', '一般', '不满意'];   // 空串 '' 表示尚未回访

// 字段英文 key -> 中文标签（用户可见的校验提示一律用中文标签）
export const FIELD_LABELS = {
  title: '问题标题',
  department: '所属科室',
  reporter: '提出人',
  contact: '联系方式',
  type: '问题类型',
  severity: '严重程度',
  status: '状态',
  description: '问题描述',
  handler: '处理人',
  registrar: '登记人',
  softwareSystem: '软件系统',
  resolution: '处理说明',
  satisfaction: '满意度',
  feedback: '回访备注',
};

const CREATE_REQUIRED = ['title', 'department', 'reporter', 'type', 'severity', 'description'];
// 注意：createdBy 由服务端从登录态注入，绝不接受前端传入，故不在此列表中
const ALL_FIELDS = ['title', 'department', 'reporter', 'contact', 'type', 'severity', 'status', 'description', 'handler', 'registrar', 'softwareSystem', 'resolution', 'satisfaction', 'feedback'];

function sanitize(body = {}) {
  const out = {};
  for (const k of ALL_FIELDS) {
    if (body[k] !== undefined) out[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
  }
  return out;
}

// 满意度取值校验：空串（未回访）或非法值均报错；其他文本字段在 sanitize 中已处理
function checkSatisfaction(errors, body) {
  if (body.satisfaction && !SATISFACTIONS.includes(body.satisfaction)) {
    errors.push(`满意度取值非法：${body.satisfaction}（可选：满意、一般、不满意）`);
  }
}

export function validateCreate(body = {}) {
  const errors = [];
  for (const f of CREATE_REQUIRED) {
    if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') {
      errors.push(`「${FIELD_LABELS[f] || f}」必填`);
    }
  }
  if (body.type && !TYPES.includes(body.type)) errors.push(`问题类型非法：${body.type}（可选：故障、需求、咨询、其他）`);
  if (body.severity && !SEVERITIES.includes(body.severity)) errors.push(`严重程度非法：${body.severity}（可选：低、中、高、紧急）`);
  if (body.status && !STATUSES.includes(body.status)) errors.push(`状态非法：${body.status}（可选：待处理、处理中、已解决、已关闭）`);
  checkSatisfaction(errors, body);
  return { ok: errors.length === 0, errors, value: sanitize(body) };
}

export function validateUpdate(body = {}) {
  const errors = [];
  if (body.type && !TYPES.includes(body.type)) errors.push(`问题类型非法：${body.type}（可选：故障、需求、咨询、其他）`);
  if (body.severity && !SEVERITIES.includes(body.severity)) errors.push(`严重程度非法：${body.severity}（可选：低、中、高、紧急）`);
  if (body.status && !STATUSES.includes(body.status)) errors.push(`状态非法：${body.status}（可选：待处理、处理中、已解决、已关闭）`);
  checkSatisfaction(errors, body);
  return { ok: errors.length === 0, errors, value: sanitize(body) };
}

// 回访打分专用校验（仅 satisfaction + feedback，独立于完整 update）
export function validateSatisfaction(body = {}) {
  const errors = [];
  if (body.satisfaction && !SATISFACTIONS.includes(body.satisfaction)) {
    errors.push(`满意度取值非法：${body.satisfaction}（可选：满意、一般、不满意）`);
  }
  const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
  return { ok: errors.length === 0, errors, value: { satisfaction: body.satisfaction || '', feedback } };
}
