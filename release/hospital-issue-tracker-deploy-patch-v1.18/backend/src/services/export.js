import ExcelJS from 'exceljs';

const COLUMNS = [
  { key: 'id', header: 'ID' },
  { key: 'title', header: '问题标题' },
  { key: 'department', header: '所属科室' },
  { key: 'reporter', header: '提出人' },
  { key: 'contact', header: '联系方式' },
  { key: 'type', header: '问题类型' },
  { key: 'severity', header: '严重程度' },
  { key: 'status', header: '状态' },
  { key: 'satisfaction', header: '满意度' },
  { key: 'feedback', header: '回访备注' },
  { key: 'description', header: '问题描述' },
  { key: 'handler', header: '处理人' },
  { key: 'registrar', header: '登记人' },
  { key: 'softwareSystem', header: '软件系统' },
  { key: 'resolution', header: '处理说明' },
  { key: 'created_at', header: '登记时间' },
  { key: 'updated_at', header: '更新时间' },
  { key: 'resolved_at', header: '解决时间' },
  // 审核 4 列（v1.2）
  { key: 'audit_status', header: '审核状态' },
  { key: 'audit_reason', header: '审核意见' },
  { key: 'audit_by', header: '审核人' },
  { key: 'audit_at', header: '审核时间' },
];

// 对外暴露完整列定义（路由据此做字段白名单校验）
export const EXPORT_COLUMNS = COLUMNS;

function escapeCsv(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 排序字段中文名（用于导出说明）
const SORT_LABELS = {
  id: 'ID',
  title: '问题标题',
  department: '所属科室',
  reporter: '提出人',
  type: '问题类型',
  severity: '严重程度',
  status: '状态',
  created_at: '登记时间',
  updated_at: '更新时间',
  resolved_at: '解决时间',
};

function fmtTime(d) {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

// 把「当前筛选 + 排序」翻译成中文说明，写进导出文件，避免拿到文件后不知道是什么条件下的数据。
// 多值筛选（v1.18.45）：status/type/department 为逗号分隔多值，展示时改为「、」连接。
function fmtMulti(v) {
  if (Array.isArray(v)) return v.join('、');
  return String(v).split(',').join('、');
}

export function describeConditions(query = {}, total = 0, extra = {}) {
  const parts = [];
  if (query.status) parts.push(`状态=${fmtMulti(query.status)}`);
  if (query.auditStatus) parts.push(`审核状态=${query.auditStatus}`);
  if (query.type) parts.push(`问题类型=${fmtMulti(query.type)}`);
  if (query.department) parts.push(`所属科室=${fmtMulti(query.department)}`);
  if (query.keyword) parts.push(`关键字=${query.keyword}`);
  const filterText = parts.length ? parts.join('；') : '全部数据（未筛选）';
  const sortBy = SORT_LABELS[query.sort] || SORT_LABELS.created_at;
  const dir = query.order === 'asc' ? '升序' : '降序';
  const fieldsText = Array.isArray(extra.fields) && extra.fields.length
    ? extra.fields.join('、')
    : '全部字段';
  return {
    filterText,
    sortText: `${sortBy} ${dir}`,
    fieldsText,
    total,
    exportedAt: fmtTime(extra.exportedAt || new Date()),
    exportedBy: extra.exportedBy || '—',
  };
}

function conditionLine(meta = {}) {
  const m = meta.conditions;
  if (!m) return '';
  return `导出条件：${m.filterText} ｜ 排序：${m.sortText} ｜ 导出字段：${m.fieldsText} ｜ 记录数：${m.total} ｜ 导出时间：${m.exportedAt} ｜ 导出人：${m.exportedBy}`;
}

export function toCSV(rows, meta = {}) {
  const cols = meta.columns && meta.columns.length ? meta.columns : COLUMNS;
  const head = '﻿' + cols.map((c) => c.header).join(',');
  const body = rows.map((r) => cols.map((c) => escapeCsv(r[c.key])).join(',')).join('\n');
  const note = conditionLine(meta);
  return (note ? escapeCsv(note) + '\n' : '') + head + '\n' + body;
}

export async function toXLSX(rows, meta = {}) {
  const cols = meta.columns && meta.columns.length ? meta.columns : COLUMNS;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('软件问题');
  const note = conditionLine(meta);

  // 注意：不要用 ws.columns 赋值来写表头——它会把表头强行放到第 1 行、覆盖已写入的说明行。
  // 这里全部用 addRow 显式构造，行号完全可控。
  if (note) {
    const noteRow = ws.addRow([note]);
    noteRow.font = { size: 10, color: { argb: 'FF475569' } };
    ws.mergeCells(1, 1, 1, cols.length);
    ws.addRow([]);   // 空行，把表头与说明隔开
  }
  const headerRow = ws.addRow(cols.map((c) => c.header));
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  });
  for (const r of rows) ws.addRow(cols.map((c) => r[c.key] ?? ''));

  cols.forEach((c, i) => { ws.getColumn(i + 1).width = 18; });

  // 冻结说明行与表头，滚动时列名始终可见
  ws.views = [{ state: 'frozen', ySplit: note ? 3 : 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ===== v1.18.24：底稿登记清单导出（「审核通过」菜单 → 卫宁底稿系统登记用）=====
// 列与推断规则依据 draft-operations skill（references/mapping-rules.md / inference-rules.md）：
// 需要人工在底稿系统补填的列（businessTypeId / productId / 科室成员电话 / accountProjectId / 提需人角色）一律留空，
// 宁可留白人工选，也不给一个「看起来能用」的猜测值（业务分类必须选叶子节点，推断方向仅供参考）。
export const DRAFT_COLUMNS = [
  { key: 'title', header: '标题', width: 34 },
  { key: 'draftType', header: '底稿类型', width: 12 },
  { key: 'draftCategory', header: '底稿分类', width: 14 },
  { key: 'businessDirection', header: '业务分类方向', width: 22 },
  { key: 'businessTypeId', header: 'businessTypeId', width: 16 },
  { key: 'productId', header: 'productId', width: 16 },
  { key: 'priority', header: '优先级', width: 14 },
  { key: 'department', header: '提出科室', width: 14 },
  { key: 'member', header: '科室成员', width: 12 },
  { key: 'memberPhone', header: '科室成员电话', width: 14 },
  { key: 'accountProjectId', header: '在建项目accountProjectId', width: 24 },
  { key: 'description', header: '问题描述', width: 44 },
  { key: 'registerDate', header: '登记日期', width: 12 },
  { key: 'source', header: '来源', width: 12 },
  { key: 'requesterRole', header: '提需人角色', width: 12 },
  { key: 'hospital', header: '医院', width: 22 },
];

// 底稿类型：故障→1-Bug；需求→2-需求；其它（咨询/其他）→空（人工判断，基础数据=3）
function draftTypeOf(type) {
  const t = String(type || '');
  if (t.includes('故障')) return '1-Bug';
  if (t.includes('需求')) return '2-需求';
  return '';
}

// 底稿分类：Bug→1-系统BUG类；需求→2-需求改造类；其它→空（5-基础数据类 / 6-接口对接类人工可选）
function draftCategoryOf(type) {
  const t = String(type || '');
  if (t.includes('故障')) return '1-系统BUG类';
  if (t.includes('需求')) return '2-需求改造类';
  return '';
}

// 优先级：严重程度 高→2-A级-紧急；中→3-B级-急；低→4-C级-一般；其它（紧急）→空。
// S级(1)已禁用不用；D级(5-暂缓)不在登记问题严重程度枚举内，不映射。
function priorityOf(severity) {
  const s = String(severity || '');
  if (s === '高') return '2-A级-紧急';
  if (s === '中') return '3-B级-急';
  if (s === '低') return '4-C级-一般';
  return '';
}

// 登记日期 = 审核通过时间，yyyy-MM-dd（本地时区）
function fmtDate(d) {
  if (!d) return '';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

// 一行问题 → 一行底稿登记清单记录。orgName 作「医院」列参考（hospitalId 需人工在底稿系统确认）。
export function buildDraftRecord(r, orgName = '') {
  return {
    title: r.title ?? '',
    draftType: draftTypeOf(r.type),
    draftCategory: draftCategoryOf(r.type),
    businessDirection: r.softwareSystem ?? '',
    businessTypeId: '',        // 必须人工从业务分类树叶子节点选（selectFlag=true 且有 productId）
    productId: '',             // 与 businessTypeId 同一叶子节点成对取
    priority: priorityOf(r.severity),
    department: r.department ?? '',
    member: r.reporter ?? '',  // 提出人姓名，需人工核对到底稿系统科室成员字典
    memberPhone: '',           // 底稿系统从科室成员 remark「手机号|科室」解析，人工填
    accountProjectId: '',      // 人工从在建项目取 projectId 业务ID（勿用表主键 id）
    description: r.description ?? '',
    registerDate: fmtDate(r.audit_at),
    source: '2-实施提需',
    requesterRole: '',         // 仅需求类型必填，人工填
    hospital: orgName || '',
  };
}

// Sheet2「登记要点」：把 draft-operations skill 的防错规则沉淀成逐行文字，
// 登记人照着念就能避开历史踩过的坑（accountProjectId 传错主键、status 落 NULL 等）。
export function draftRegisterLines() {
  return [
    '【底稿登记要点】（以下规则来自底稿系统对接实践，登记前请逐条核对）',
    '1. accountProjectId 必须用在建项目接口返回的 projectId 字段值（业务ID），不是表主键 id。',
    '2. businessTypeId 必须选业务分类树的叶子节点（selectFlag=true 且有 productId），productId 必须与该叶子节点的 productId 成对取值。',
    '3. level（优先级）：A级=2 / B级=3 / C级=4 / D级=5；S级(1)已禁用；默认取医院配置返回的 level 值。',
    '4. source（来源）默认 2（实施提需）。',
    '5. 登记两步走：先 saveDraft 保存草稿，再 submitSheet 提交；两步均不要传 status（后端状态机自动置值，提交后强制为 2-新登记）。',
    '6. 提交后必须回查详情确认 status=2 才算登记成功。',
    '7. 底稿类型：Bug=1 / 需求=2 / 基础数据=3。',
  ];
}

// 生成底稿登记清单 xlsx：Sheet1 每行一个已通过问题；Sheet2 为登记防错要点。
// 行数多时常规 addRow 即可（与现有 toXLSX 同量级，千行内无性能问题）。
export async function toDraftXLSX(rows, meta = {}) {
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet('底稿登记清单');
  const headerRow = ws.addRow(DRAFT_COLUMNS.map((c) => c.header));
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  });
  for (const r of rows) ws.addRow(DRAFT_COLUMNS.map((c) => r[c.key] ?? ''));
  DRAFT_COLUMNS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const ws2 = wb.addWorksheet('登记要点');
  for (const line of draftRegisterLines()) ws2.addRow([line]);
  ws2.getColumn(1).width = 110;
  ws2.getRow(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

const AUDIT_COLUMNS = [
  { key: 'created_at', header: '时间' },
  { key: 'username', header: '操作人' },
  { key: 'action', header: '操作' },
  { key: 'target', header: '对象' },
  { key: 'detail', header: '详情' },
];

// 操作类型中文名（与前端 AuditLog.vue 的映射保持一致；未知 action 原样输出）
export const ACTION_LABELS = {
  LOGIN: '登录',
  CHANGE_PASSWORD: '修改密码',
  CREATE_ISSUE: '登记问题',
  UPDATE_ISSUE: '编辑问题',
  DELETE_ISSUE: '删除问题',
  RESTORE_ISSUE: '回收站恢复',
  PURGE_ISSUE: '彻底删除问题',
  APPROVE_ISSUE: '审核通过',
  REJECT_ISSUE: '审核不通过',
  BULK_UPDATE_STATUS: '批量改状态',
  BULK_DELETE_ISSUE: '批量删除问题',
  RATE_SATISFACTION: '回访打分',
  UPLOAD_ATTACHMENT: '上传附件',
  DELETE_ATTACHMENT: '删除附件',
  CREATE_USER: '新增用户',
  UPDATE_USER_ROLE: '修改用户角色',
  RESET_PASSWORD: '重置密码',
  ENABLE_USER: '启用用户',
  DISABLE_USER: '停用用户',
  UPDATE_SETTINGS: '修改系统设置',
  SEND_NOTIFICATION: '发送通知',
  BROADCAST_NOTIFICATION: '发送全员通知',
  CREATE_SCHEDULE: '新增排班',
  UPDATE_SCHEDULE: '修改排班',
  DELETE_SCHEDULE: '删除排班',
  COPY_SCHEDULE: '复制排班',
  CREATE_CHAT: '新建会话',
  UPLOAD_CHAT_ATTACHMENT: '上传聊天附件',
  // 多机构（v1.18）
  CREATE_ORG: '新建机构',
  UPDATE_ORG: '修改机构',
  DELETE_ORG: '删除机构',
  UPDATE_ORG_MEMBER: '设置机构成员',
  REMOVE_ORG_MEMBER: '移出机构成员',
  SWITCH_ORG: '切换机构',
  GRANT_PLATFORM_ADMIN: '设为平台管理员',
  REVOKE_PLATFORM_ADMIN: '取消平台管理员',
  // 用户类型与多机构分配（v1.18.12）
  UPDATE_USER_TYPE: '修改用户类型',
  ASSIGN_USER_ORG: '分配用户机构',
  REMOVE_USER_ORG: '移出用户机构',
  // 用户联系电话（v1.18.17）
  UPDATE_USER_PHONE: '修改联系电话',
  // 排班跨机构同步（v1.18.13）
  SYNC_SCHEDULE: '跨机构同步排班',
  // 工时配置（v1.18.43）
  UPDATE_TS_CONFIG: '修改工时配置',
  UPDATE_TS_TOKEN: '修改工时服务Token',
};

function auditActionLabel(r) {
  return ACTION_LABELS[r.action] || r.action || '';
}

export function auditToCSV(rows) {
  const head = '﻿' + AUDIT_COLUMNS.map((c) => c.header).join(',');
  const body = rows.map((r) => AUDIT_COLUMNS.map((c) => escapeCsv(c.key === 'action' ? auditActionLabel(r) : r[c.key])).join(',')).join('\n');
  return head + '\n' + body;
}

export async function auditToXLSX(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('操作日志');
  ws.columns = AUDIT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: 22 }));
  ws.addRows(rows.map((r) => {
    const o = {};
    for (const c of AUDIT_COLUMNS) o[c.key] = c.key === 'action' ? auditActionLabel(r) : (r[c.key] ?? '');
    return o;
  }));
  ws.getRow(1).font = { bold: true };
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
