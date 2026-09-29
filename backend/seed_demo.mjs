import fs from 'node:fs';

const path = 'D:/AI/海盐县人民医院/信息科登记问题程序/backend/data/issues.json';
const now = new Date('2026-09-21T10:00:00.000Z');

// 构造跨 2026-06 ~ 2026-09 的演示数据，让「按月度趋势」与「按科室分布」有内容可看
function at(month, day, h = 10) {
  return new Date(`2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`).toISOString();
}

const seed = [
  { title: 'HIS 门诊医生站无法登录', department: '内科', reporter: '张医生', type: '故障', severity: '高', status: '已解决', description: '部分医生站登录报错 500', handler: '信息科-王工', resolution: '重启应用服务后恢复', createdBy: 'admin', satisfaction: '满意', feedback: '处理很及时', created_at: at(6, 3), updated_at: at(6, 4), resolved_at: at(6, 4) },
  { title: 'LIS 检验结果延迟', department: '检验科', reporter: '李技师', type: '故障', severity: '中', status: '处理中', description: '检验结果上传延迟约 5 分钟', handler: '信息科-王工', resolution: '', createdBy: 'admin', satisfaction: '', feedback: '', created_at: at(6, 12), updated_at: at(7, 1), resolved_at: null },
  { title: 'PACS 影像调阅卡顿', department: '影像科', reporter: '赵主任', type: '故障', severity: '紧急', status: '已解决', description: '高峰期调阅 CT 图像卡顿', handler: '信息科-陈工', resolution: '优化存储网络', createdBy: 'admin', satisfaction: '一般', feedback: '比之前好些但还是略慢', created_at: at(7, 8), updated_at: at(7, 9), resolved_at: at(7, 9) },
  { title: '护士站报表导出需求', department: '护理部', reporter: '护理部-周', type: '需求', severity: '中', status: '处理中', description: '希望新增按科室统计的护士工作量报表', handler: '', resolution: '', createdBy: 'reporter1', satisfaction: '', feedback: '', created_at: at(7, 15), updated_at: at(7, 15), resolved_at: null },
  { title: '医保接口偶发超时', department: '财务科', reporter: '财务-孙', type: '故障', severity: '高', status: '已解决', description: '医保实时结算偶发超时', handler: '信息科-王工', resolution: '调整超时参数并重试', createdBy: 'admin', satisfaction: '满意', feedback: '', created_at: at(7, 22), updated_at: at(7, 23), resolved_at: at(7, 23) },
  { title: '电子病历模板咨询', department: '儿科', reporter: '儿科-吴', type: '咨询', severity: '低', status: '已关闭', description: '问下如何自定义儿科病历模板', handler: '信息科-陈工', resolution: '已远程指导完成', createdBy: 'admin', satisfaction: '不满意', feedback: '指导不够清晰', created_at: at(8, 2), updated_at: at(8, 3), resolved_at: at(8, 3) },
  { title: '自助机打印故障', department: '门诊办', reporter: '门诊-郑', type: '故障', severity: '中', status: '待处理', description: '2 号楼自助机无法打印检验报告', handler: '', resolution: '', createdBy: '', satisfaction: '', feedback: '', created_at: at(8, 11), updated_at: at(8, 11), resolved_at: null },
  { title: '抗菌药物系统权限申请', department: '药剂科', reporter: '药剂-冯', type: '需求', severity: '低', status: '已解决', description: '申请新增一组药师抗菌药物权限', handler: '信息科-陈工', resolution: '已配置角色权限', createdBy: 'admin', satisfaction: '满意', feedback: '', created_at: at(8, 18), updated_at: at(8, 19), resolved_at: at(8, 19) },
  { title: '急诊分诊屏不显示', department: '急诊科', reporter: '急诊-蒋', type: '故障', severity: '紧急', status: '处理中', description: '急诊大厅分诊大屏黑屏', handler: '信息科-王工', resolution: '', createdBy: 'admin', satisfaction: '', feedback: '', created_at: at(9, 5), updated_at: at(9, 6), resolved_at: null },
  { title: '门诊叫号系统延迟', department: '门诊办', reporter: '门诊-郑', type: '故障', severity: '高', status: '已解决', description: '叫号延迟约 10 秒', handler: '信息科-陈工', resolution: '修复消息队列积压', createdBy: 'admin', satisfaction: '一般', feedback: '', created_at: at(9, 12), updated_at: at(9, 12), resolved_at: at(9, 12) },
  { title: '超声工作站升级咨询', department: '超声科', reporter: '超声-韩', type: '咨询', severity: '低', status: '已关闭', description: '咨询超声工作站版本升级路径', handler: '信息科-陈工', resolution: '已提供升级方案', createdBy: 'admin', satisfaction: '', feedback: '', created_at: at(9, 16), updated_at: at(9, 17), resolved_at: at(9, 17) },
  { title: '骨科随访小程序报错', department: '骨科', reporter: '骨科-杨', type: '故障', severity: '中', status: '待处理', description: '随访小程序提交时报网络错误', handler: '', resolution: '', createdBy: 'reporter1', satisfaction: '', feedback: '', created_at: at(9, 19), updated_at: at(9, 19), resolved_at: null },
];

const rows = seed.map((s, i) => ({ id: i + 1, ...s }));
fs.writeFileSync(path, JSON.stringify(rows, null, 2), 'utf8');
console.log('seeded', rows.length, 'demo records to', path);
