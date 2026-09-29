// 实施协同 · 工时登记（v1.18.42 原生集成；v1.18.43 配置搬进前端 + 按用户隔离）。
// PMIS-MCP / WXP 全部业务逻辑在本系统内实现（src/timesheet/），无外部进程依赖。
// v1.18.43：每个公司用户可在「系统管理 → 工时配置」维护**自己的**配置记录——
//   我的 WXP 账号（工号+密码）/ 填报默认值 / 医院→在建项目绑定（存 app_user_ts_config，按用户隔离）。
// 生效规则：**个人配置优先，未配置的项回落系统默认（backend/Configs/）**——
//   个人凭据要求工号与密码同时填写才算生效（避免半配置混用别人的密码）。
//   知识库（timesheet-kb.json）保持全局共享（常用语库，非个人配置）。

import express from 'express';
import { authenticate } from '../auth/middleware.js';
import { requirePlatformAdmin } from '../auth/authorize.js';
import { audit } from '../audit/index.js';
import {
  getTimesheetFileConfig, getHospitalConfigsDict, getHospitalConfig,
  getWxpSettings, getMcpServer, updateMcpToken,
} from '../timesheet/configs.js';
import { getUserTsConfig, saveUserTsConfig, publicTsConfig } from '../timesheet/userConfig.js';
import { getPmisUserId, callPmisApi } from '../timesheet/pmisMcp.js';
import {
  runExclusive, ensurePmisToken, invalidateAndRefresh, queryMyCustomerList,
  queryDraftsForHospital, testWxpCredential,
} from '../timesheet/wxpClient.js';
import * as kb from '../timesheet/kbStore.js';

const router = express.Router();

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// —— 生效凭据解析：个人配置（工号+密码齐备）优先，否则回落系统默认账号 ——
function resolveCred(own) {
  const g = getWxpSettings();
  if (own?.wxpUserCode && own?.wxpPassword) {
    return { userCode: own.wxpUserCode, password: own.wxpPassword, source: 'own' };
  }
  if (g.userCode && g.password) {
    return { userCode: g.userCode, password: g.password, source: 'global' };
  }
  return { userCode: '', password: '', source: 'none' };
}

/** 每次请求的工时上下文：个人配置（可能为 null）+ 生效凭据 */
async function tsContext(req) {
  const own = await getUserTsConfig({ userId: req.user.id, username: req.user.username });
  return { own, cred: resolveCred(own) };
}

/** 医院→在建项目绑定合并：个人绑定覆盖同名医院，未配置的回落全局 */
function mergedBindings(own) {
  const merged = { ...getHospitalConfigsDict() };
  for (const [code, b] of Object.entries(own?.bindings || {})) {
    merged[code] = {
      hospitalName: b.hospitalName || merged[code]?.hospitalName || '',
      inProjectId: Number(b.inProjectId) || 0,
      inProjectName: b.inProjectName || '',
      draftViewId: merged[code]?.draftViewId || '',
    };
  }
  return merged;
}

/** 填报默认值合并：个人 defaults 覆盖全局 timesheet.json 的 Default* */
function mergedDefaults(own) {
  const ts = getTimesheetFileConfig();
  return {
    defaultTimesheetType: num(own?.defaults?.timesheetType ?? ts.DefaultTimesheetType, 2),
    defaultCostLineId: num(own?.defaults?.costLineId ?? ts.DefaultCostLineId, 2),
    defaultProcessType: num(own?.defaults?.processType ?? ts.DefaultProcessType, 62),
    defaultWorkHours: num(own?.defaults?.workHours ?? ts.DefaultWorkHours, 8),
  };
}

// 配置：工时类型/费用条线/工序类型/默认值/医院→在建项目绑定（与 WXP TimesheetConfig 同构；
// v1.18.43 起默认值与绑定按「个人配置优先」合并返回，另附 hasOwn/usingGlobalAccount 供前端提示）
router.get('/config', authenticate, async (req, res) => {
  const { own, cred } = await tsContext(req);
  const ts = getTimesheetFileConfig();
  const list = (arr) => (Array.isArray(arr) ? arr : []);
  const pairs = (arr) => list(arr).map((x) => ({ value: num(x?.value, 0), label: String(x?.label ?? '') }));
  const hospitalConfigs = Object.entries(mergedBindings(own)).map(([code, cfg]) => ({
    hospitalId: code,
    hospitalName: cfg.hospitalName,
    inProjectId: cfg.inProjectId,
    inProjectName: cfg.inProjectName,
    draftViewId: cfg.draftViewId,
  }));
  return res.json({
    ...mergedDefaults(own),
    inProgressStatus: list(ts.InProgressStatusList),
    timesheetTypes: pairs(ts.TimesheetTypes),
    costLineOptions: pairs(ts.CostLineOptions),
    processTypeOptions: pairs(ts.ProcessTypeOptions),
    hospitalConfigs,
    hasOwn: Boolean(own),
    usingGlobalAccount: cred.source === 'global',
  });
});

// —— 工时配置（v1.18.43）：每个登录用户自己的配置记录 ——
// 读取（密码永不回显，只给 hasPassword；usingGlobalAccount=正在用系统默认账号）
router.get('/my-config', authenticate, async (req, res) => {
  const { own, cred } = await tsContext(req);
  return res.json({
    success: true,
    hasOwn: Boolean(own),
    usingGlobalAccount: cred.source === 'global',
    config: publicTsConfig(own) || { wxpUserCode: '', hasPassword: false, defaults: {}, bindings: {}, updatedAt: null },
  });
});

// 保存（patch 语义：wxpPassword 空串/缺省 = 保留原密码；bindings 里医院值为 null = 清除该绑定）
router.put('/my-config', authenticate, async (req, res) => {
  const b = req.body || {};
  if (b.wxpUserCode != null && typeof b.wxpUserCode !== 'string') {
    return res.json({ success: false, message: '工号格式不正确' });
  }
  if (b.wxpPassword != null && typeof b.wxpPassword !== 'string') {
    return res.json({ success: false, message: '密码格式不正确' });
  }
  if (b.wxpUserCode === '' && (b.wxpPassword == null || b.wxpPassword === '')) {
    // 清空凭据 = 回落系统默认账号（允许，但需要显式清空两个字段）
  }
  try {
    const saved = await saveUserTsConfig(
      { userId: req.user.id, username: req.user.username },
      {
        wxpUserCode: b.wxpUserCode,
        wxpPassword: b.wxpPassword,
        defaults: b.defaults,
        bindings: b.bindings,
      },
    );
    await audit({
      username: req.user.username,
      action: 'UPDATE_TS_CONFIG',
      target: req.user.username,
      detail: `工号=${saved.wxpUserCode || '（空）'}；默认值=${Object.keys(saved.defaults).length} 项；绑定=${Object.keys(saved.bindings).length} 家`,
    });
    return res.json({ success: true, message: '工时配置已保存（仅本人生效）', config: publicTsConfig(saved) });
  } catch (err) {
    return res.json({ success: false, message: `保存失败：${err?.message || err}` });
  }
});

// 测试连接（用提交的工号+密码直接登录 PMIS/WXP；密码留空且本人已存过密码则用已存密码）
router.post('/my-config/test', authenticate, async (req, res) => {
  const b = req.body || {};
  let userCode = typeof b.wxpUserCode === 'string' ? b.wxpUserCode.trim() : '';
  let password = typeof b.wxpPassword === 'string' ? b.wxpPassword : '';
  if (userCode && !password) {
    const own = await getUserTsConfig({ userId: req.user.id, username: req.user.username });
    if (own && own.wxpUserCode === userCode && own.wxpPassword) password = own.wxpPassword;
  }
  const r = await testWxpCredential({ userCode, password });
  return res.json({ success: r.ok, message: r.message || '' });
});

// 我的医院列表（WXP 动态拉取 + 绑定合并；鉴权失败原子重登重试一次）
// v1.18.46 起绑定生效优先级：**个人绑定 > 自动匹配（按医院名检索本人 PMIS 在建项目，项目名/客户名
// 包含医院名即命中）> 系统默认（Configs 固定绑定，兜底）**，每项带 source=own|auto|sys|none
// 供工时配置页标注来源；inProjectId/inProjectName 恒为「当前生效值」，工时登记页零改动直接受益。
router.get('/hospitals', authenticate, async (req, res) => {
  try {
    const { own, cred } = await tsContext(req);
    const core = await runExclusive(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await ensurePmisToken(cred);
        if (!token) return { error: '请先在「系统管理 → 工时配置」填写 WXP 工号与密码' };
        const r = await queryMyCustomerList(cred);
        if (r.authFailed) {
          if (attempt === 0) { await invalidateAndRefresh(cred); continue; }
          return { error: '登录已过期，自动重试仍失败，请检查工时配置里的工号与密码' };
        }
        if (!r.ok) return { error: r.message || '医院列表获取失败' };
        return { hospitals: r.hospitals };
      }
      return { error: '登录已过期，自动重试仍失败，请检查工时配置里的工号与密码' };
    });
    if (core.error) return res.json({ success: false, message: core.error });

    // 锁外自动匹配（并行；单院失败静默回落，不拖垮整表）
    const localCfgs = mergedBindings(own);
    const autos = await Promise.all(core.hospitals.map(async (h) => {
      try {
        const found = await searchPmisProjects(h.hospitalName);
        if (!found.ok) return null;
        const hit = found.items.find((p) => {
          const name = String(h.hospitalName || '').trim();
          return name && (p.inProjectName.includes(name) || p.customerName.includes(name));
        });
        return hit ? { inProjectId: hit.inProjectId, inProjectName: hit.inProjectName } : null;
      } catch { return null; }
    }));

    const hospitals = core.hospitals.map((h, i) => {
      const cfg = localCfgs[h.hospitalCode];
      const ownB = own?.bindings?.[h.hospitalCode];
      const auto = autos[i];
      const sysB = (cfg && cfg.inProjectId > 0) ? cfg : null;
      const source = (ownB && Number(ownB.inProjectId) > 0) ? 'own'
        : auto ? 'auto'
          : sysB ? 'sys' : 'none';
      const eff = source === 'own' ? { id: ownB.inProjectId, name: ownB.inProjectName || '' }
        : source === 'auto' ? { id: auto.inProjectId, name: auto.inProjectName }
          : source === 'sys' ? { id: sysB.inProjectId, name: sysB.inProjectName }
            : { id: 0, name: '' };
      return {
        hospitalId: h.hospitalCode,
        hospitalName: cfg?.hospitalName || h.hospitalName,
        hospitalCode: h.hospitalCode,
        province: h.province,
        city: h.city,
        inProjectId: eff.id,
        inProjectName: eff.name || null,
        draftViewId: cfg?.draftViewId || null,
        hasConfig: eff.id > 0,
        source,
      };
    });
    return res.json({ success: true, hospitals });
  } catch (err) {
    return res.json({ success: false, message: err?.message || String(err) });
  }
});

// —— 服务连接（v1.18.46，仅平台管理员）：PMIS-MCP 地址与 Token 的界面化维护 ——
// 此前 token 过期只能登服务器改 Configs/mcp.json；现可在「工时配置」页直接更换（写回文件+自动备份，即时生效）。
router.get('/server-config', authenticate, requirePlatformAdmin(), async (req, res) => {
  const m = getMcpServer();
  const token = String(m.authorization || '').replace(/^Bearer\s+/i, '');
  const tokenMasked = token ? (token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-4)}` : '******') : '';
  return res.json({
    success: true,
    url: m.url,
    hasToken: Boolean(token),
    tokenMasked,
    // env 优先级最高：env 存在时界面修改不生效（返回标注，前端提示先移除 env）
    fromEnv: Boolean(process.env.PMIS_MCP_TOKEN),
  });
});

router.put('/server-config', authenticate, requirePlatformAdmin(), async (req, res) => {
  const t = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!t) return res.json({ success: false, message: 'token 不能为空' });
  if (t.length > 500) return res.json({ success: false, message: 'token 过长（上限 500 字符）' });
  if (process.env.PMIS_MCP_TOKEN) {
    return res.json({ success: false, message: '当前 token 由环境变量 PMIS_MCP_TOKEN 覆盖，界面修改不生效；请先移除该环境变量并重启后端' });
  }
  try {
    const saved = updateMcpToken(t);
    await audit({
      username: req.user.username,
      action: 'UPDATE_TS_TOKEN',
      target: 'PMIS-MCP',
      detail: `Token 已更新（长度 ${saved.length} 字符）`, // 审计只记长度，不落明文
    });
    return res.json({ success: true, message: 'PMIS-MCP Token 已更新（写回 Configs/mcp.json，即时生效，无需重启）' });
  } catch (err) {
    return res.json({ success: false, message: err?.message || String(err) });
  }
});

// 某医院的在建项目候选（PMIS API 65 模糊检索；当前绑定的排最前 → 执行中 → 项目 ID 倒序）
// —— 检索内核抽为 searchPmisProjects（v1.18.46）：/projects 与 /hospitals 的自动匹配共用
async function searchPmisProjects(keyword) {
  if (!keyword || !String(keyword).trim()) {
    return { ok: false, error: '缺少检索关键字', items: [] };
  }
  const userId = await getPmisUserId();
  if (!userId) return { ok: false, error: '获取 PMIS 用户 ID 失败（PMIS-MCP get_user_token 调用失败）', items: [] };

  // keyword 匹配"在建项目名称 / 合同名称"；日期范围放宽到 2000 年，避免默认窗口漏掉老项目
  const queryParams = JSON.stringify({
    keyword,
    register_start_date: '2000-01-01',
    register_end_date: new Date().toISOString().slice(0, 10),
  });
  const { rows, error } = await callPmisApi('65', { user_id: userId, query_params: queryParams });
  if (error) return { ok: false, error, items: [] };

  const pick = (r, keys) => {
    for (const k of keys) {
      const v = r[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  };

  const seen = new Set();
  const items = [];
  for (const r of rows) {
    const pid = parseInt(r['在建项目ID'], 10);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    items.push({
      inProjectId: pid,
      inProjectName: pick(r, ['在建项目名称', '项目名称']),
      customerName: pick(r, ['客户名称', '客户']),
      managerName: pick(r, ['项目经理', '项目负责人']),
      projectType: pick(r, ['项目类型']),
      executeStatus: pick(r, ['执行状态']),
    });
  }
  // "执行"中的排前，再按项目 ID 倒序（新项目靠前）
  items.sort((a, b) => (Number(b.executeStatus === '执行') - Number(a.executeStatus === '执行')) || (b.inProjectId - a.inProjectId));
  return { ok: true, items, error: null };
}

router.get('/projects', authenticate, async (req, res) => {
  const { own } = await tsContext(req);
  const cfgs = mergedBindings(own);
  let configuredId = 0;
  let configuredName = '';
  let hospitalName = typeof req.query.hospitalName === 'string' ? req.query.hospitalName : '';
  if (req.query.hospitalCode && cfgs[req.query.hospitalCode]) {
    const cfg = cfgs[req.query.hospitalCode];
    configuredId = cfg.inProjectId;
    configuredName = cfg.inProjectName;
    if (cfg.hospitalName) hospitalName = cfg.hospitalName;
  }
  const keyword = typeof req.query.keyword === 'string' && req.query.keyword.trim()
    ? req.query.keyword.trim() : (hospitalName || '').trim();
  if (!keyword) {
    return res.json({ success: false, message: '缺少 hospitalName / keyword，无法检索在建项目' });
  }

  const found = await searchPmisProjects(keyword);
  if (!found.ok) return res.json({ success: false, message: found.error });
  const items = found.items.map((p) => ({ ...p, isConfigured: p.inProjectId === configuredId }));
  // 当前绑定的排最前，其次"执行"中的，再按项目 ID 倒序（新项目靠前）
  items.sort((a, b) => (Number(b.isConfigured) - Number(a.isConfigured))
    || (Number(b.executeStatus === '执行') - Number(a.executeStatus === '执行'))
    || (b.inProjectId - a.inProjectId));

  return res.json({
    success: true,
    keyword,
    configuredId,
    configuredName,
    count: items.length,
    projects: items,
  });
});

// 工时登记页「记住」按钮：把医院→在建项目选择写回**本人**配置（v1.18.43 起不再写全局文件）
router.post('/save-project', authenticate, async (req, res) => {
  const b = req.body || {};
  if (!b.hospitalCode || !(Number(b.inProjectId) > 0)) {
    return res.json({ success: false, message: '参数不完整：需要 hospitalCode + inProjectId' });
  }
  try {
    await saveUserTsConfig(
      { userId: req.user.id, username: req.user.username },
      {
        bindings: {
          [String(b.hospitalCode)]: {
            hospitalName: b.hospitalName || '',
            inProjectId: Number(b.inProjectId),
            inProjectName: b.inProjectName || '',
          },
        },
      },
    );
    await audit({
      username: req.user.username,
      action: 'UPDATE_TS_CONFIG',
      target: req.user.username,
      detail: `登记页记住绑定：${b.hospitalName || b.hospitalCode} → 项目 ${b.inProjectId}`,
    });
    return res.json({ success: true, message: '已记住到我的工时配置（下次打开默认用它）' });
  } catch (err) {
    return res.json({ success: false, message: `写入失败：${err?.message || err}` });
  }
});

// 未填报日期查询（PMIS API 115 经 MCP；fillUser 缺省取本人生效工号）
router.get('/unfilled', authenticate, async (req, res) => {
  const { cred } = await tsContext(req);
  const fillUser = (typeof req.query.fillUser === 'string' && req.query.fillUser) || cred.userCode;
  const queryParams = {};
  if (req.query.startDate) queryParams.start_date = req.query.startDate;
  if (req.query.endDate) queryParams.end_date = req.query.endDate;
  if (fillUser) queryParams.fill_user = fillUser;

  const { rows, error } = await callPmisApi('115', { user_id: null, query_params: JSON.stringify(queryParams) });
  if (error) return res.json({ success: false, message: error });

  const dates = [...new Set(rows.filter((r) => r['日期']).map((r) => r['日期']).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  return res.json({ success: true, totalDays: dates.length, dates, rows });
});

// 单医院底稿预览（按日期拉 WXP 底稿生成工作内容；鉴权失败原子重登重试一次）
router.get('/drafts', authenticate, async (req, res) => {
  const hospitalId = typeof req.query.hospitalId === 'string' ? req.query.hospitalId : '';
  if (!hospitalId) return res.json({ success: false, message: '请先选择医院' });
  const hospitalName = typeof req.query.hospitalName === 'string' ? req.query.hospitalName : '';
  const workDate = typeof req.query.workDate === 'string' ? req.query.workDate : '';
  const includeInProgress = req.query.includeInProgress === 'true' || req.query.includeInProgress === '1';

  try {
    const { own, cred } = await tsContext(req);
    const binding = mergedBindings(own)[hospitalId] || null;
    const out = await runExclusive(async () => {
      const token = await ensurePmisToken(cred);
      if (!token) return { success: false, message: '请先在「系统管理 → 工时配置」填写 WXP 工号与密码' };
      for (let attempt = 0; attempt < 2; attempt++) {
        let result = null;
        try {
          result = await queryDraftsForHospital({
            cred, hospitalId, hospitalName, workDate, includeInProgress, binding,
          });
        } catch (err) {
          return { success: false, message: err?.message || String(err) };
        }
        if (result == null) {
          if (attempt === 0) { await invalidateAndRefresh(cred); continue; }
          break;
        }
        return {
          success: true,
          hospitalName: result.hospitalName,
          mineCount: result.mineCount,
          closedTodayCount: result.closedTodayCount,
          inProgressCount: result.inProgressCount,
          workContent: result.workContent,
          drafts: result.topDrafts,
        };
      }
      return { success: false, message: '登录已过期，自动重试仍失败，请检查工时配置里的工号与密码' };
    });
    return res.json(out);
  } catch (err) {
    return res.json({ success: false, message: err?.message || String(err) });
  }
});

// 批量模式：全部医院底稿汇总 + 按关闭数占比均分总工时（0.5h 粒度）
router.get('/batch-drafts', authenticate, async (req, res) => {
  const workDate = typeof req.query.workDate === 'string' ? req.query.workDate : '';
  if (!workDate) return res.json({ success: false, message: '请先选择填报日期' });
  const totalHours = num(req.query.totalHours, 8);
  const includeInProgress = req.query.includeInProgress === 'true' || req.query.includeInProgress === '1';

  try {
    const { own, cred } = await tsContext(req);
    const bindings = mergedBindings(own);
    const out = await runExclusive(async () => {
      const token = await ensurePmisToken(cred);
      if (!token) return { success: false, message: '请先在「系统管理 → 工时配置」填写 WXP 工号与密码' };

      for (let attempt = 0; attempt < 2; attempt++) {
        // 1. 拉所有医院（queryMyCustomerList 内部已带网络重试；鉴权失败走整批重登）
        const hr = await queryMyCustomerList(cred, 60000);
        if (hr.authFailed) {
          if (attempt === 0) { await invalidateAndRefresh(cred); continue; }
          return { success: false, message: '登录已过期，请重新登录' };
        }
        if (!hr.ok || hr.hospitals.length === 0) {
          return { success: false, message: hr.hospitals.length === 0 ? '医院列表获取失败，请稍后重试' : (hr.message || '医院列表获取失败') };
        }

        // 2. 逐家查底稿（单家 3 次重试：限流退避 3s/5s，普通退避 1s/2s；逐院节流 500ms）
        let authFailed = false;
        let failedHospitals = 0; // 重试后仍查询失败的医院数（防止把数据缺失误显示成"0家关闭"）
        let firstFailReason = null;
        const items = [];
        let totalClosed = 0;
        let totalInprog = 0;
        let firstHospital = true;

        for (const h of hr.hospitals) {
          if (!firstHospital) await new Promise((r) => setTimeout(r, 500)); // 逐院节流防限流
          firstHospital = false;
          let r = null;
          let threw = false;
          for (let ri = 0; ri < 3; ri++) {
            try {
              r = await queryDraftsForHospital({
                cred, hospitalId: h.hospitalCode, hospitalName: h.hospitalName,
                workDate, includeInProgress, binding: bindings[h.hospitalCode] || null,
              });
              break;
            } catch (err) {
              threw = true;
              firstFailReason = firstFailReason || err?.message || String(err);
              if (ri < 2) {
                const msg = String(err?.message || err);
                const rateLimited = /ratelim|限流/i.test(msg);
                await new Promise((rl) => setTimeout(rl, rateLimited ? (ri === 0 ? 3000 : 5000) : (ri === 0 ? 1000 : 2000)));
              }
            }
          }
          if (r == null) {
            if (threw) { failedHospitals++; continue; } // 网络异常：跳过该家，不拖垮整批
            if (attempt === 0) { await invalidateAndRefresh(cred); authFailed = true; break; }
            continue;
          }
          // 唯一口径：只展示当天有本人关闭项的医院（includeInProgress 仅影响工作内容文本）
          if (r.closedTodayCount === 0) continue;
          totalClosed += r.closedTodayCount;
          totalInprog += r.inProgressCount;
          const hcfg = bindings[h.hospitalCode];
          items.push({
            hospitalId: h.hospitalCode,
            hospitalName: r.hospitalName,
            mineCount: r.mineCount,
            closedTodayCount: r.closedTodayCount,
            inProgressCount: r.inProgressCount,
            workContent: r.workContent,
            topDrafts: r.topDrafts,
            inProjectId: hcfg?.inProjectId || 0,
            inProjectName: hcfg?.inProjectName || '',
          });
        }
        if (authFailed) continue; // Token 刚过期 → 已原子重登，整批重试

        // 数据完整性防护：一家都没查到、且有医院查询失败时，绝不返回"成功+0家"
        if (items.length === 0 && failedHospitals > 0) {
          return { success: false, message: `有 ${failedHospitals} 家医院底稿获取失败，请重新分析。原因：${firstFailReason}` };
        }

        // 3. 按当天关闭数占比分配 totalHours（0.5h 粒度，最少 0.5h，余数补给关闭数最多的医院）
        let remaining = totalHours;
        for (const it of items) {
          const ratio = totalClosed > 0 ? it.closedTodayCount / totalClosed : 1.0 / Math.max(items.length, 1);
          let snapped = Math.round(totalHours * ratio * 2) / 2;
          if (snapped < 0.5) snapped = 0.5;
          if (snapped > remaining) snapped = remaining;
          remaining = Math.round((remaining - snapped) * 100) / 100;
          it.suggestedHours = snapped;
          it.ratio = Math.round(ratio * 1000) / 10;
        }
        if (remaining >= 0.5 && items.length > 0) {
          const top = [...items].sort((a, b) => b.closedTodayCount - a.closedTodayCount)[0];
          top.suggestedHours = Math.round((top.suggestedHours + remaining) * 100) / 100;
        }

        return {
          success: true,
          workDate,
          totalHours,
          totalClosed,
          totalInprog,
          rowCount: items.length,
          warning: failedHospitals > 0
            ? `另有 ${failedHospitals} 家医院底稿获取失败，结果可能不完整，建议重新分析。原因：${firstFailReason}`
            : null,
          rows: items,
        };
      }
      return { success: false, message: '登录已过期' };
    });
    return res.json(out);
  } catch (err) {
    return res.json({ success: false, message: err?.message || String(err) });
  }
});

// 单日提交（PMIS API 111 经 MCP；entries 由前端按 PMIS 字段规范拼好）
router.post('/submit', authenticate, async (req, res) => {
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.json({ success: false, message: '工时数据不能为空', detail: '' });
  }
  const userId = await getPmisUserId();
  if (!userId) {
    return res.json({ success: false, message: '获取 PMIS 用户 ID 失败（MCP get_user_token 调用失败）', detail: '' });
  }
  const queryParams = JSON.stringify({ json_array: entries });
  const bodyObj = { user_id: userId, query_params: queryParams };
  const bodyStr = JSON.stringify(bodyObj);

  const { rows, error } = await callPmisApi('111', bodyObj);
  if (error) return res.json({ success: false, message: `PMIS-MCP 调用失败：${error}`, detail: bodyStr });

  // 解析提交结果 CSV：成功导入笔数,失败笔数,总记录数
  let okCount = 0; let failCount = 0; let totalCount = 0;
  if (rows.length > 0) {
    for (const [k, v] of Object.entries(rows[0])) {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) continue;
      if (k.includes('成功') && k.includes('笔数')) okCount = n;
      if (k.includes('失败') && k.includes('笔数')) failCount = n;
      if (k.includes('总')) totalCount = n;
    }
  }
  const success = okCount > 0;
  const pmisRaw = rows.length > 0 ? JSON.stringify(rows) : '(无返回)';
  const message = success
    ? `✅ 工时提交成功：成功导入 ${okCount} 笔，失败 ${failCount} 笔（共 ${totalCount} 笔）`
    : `❌ PMIS 导入失败：成功 ${okCount} 笔，失败 ${failCount} 笔（共 ${totalCount} 笔）。PMIS 返回：${pmisRaw}\n请求体：${bodyStr}`;
  return res.json({
    success, message, okCount, failCount, totalCount,
    detail: rows.length > 0 ? JSON.stringify(rows) : '(无返回明细)',
  });
});

// 批量提交多家医院工时（每家一次调 PMIS API 111，汇总结果）
router.post('/batch-submit', authenticate, async (req, res) => {
  const entries = Array.isArray(req.body) ? req.body : [];
  if (entries.length === 0) return res.json({ success: false, message: '没有要提交的条目' });

  const userId = await getPmisUserId();
  if (!userId) return res.json({ success: false, message: '获取 PMIS 用户 ID 失败' });

  const results = [];
  let okCount = 0; let failCount = 0;
  for (const e of entries) {
    if (!(Number(e.hours) > 0) || !e.workContent) continue;
    const entryObj = {
      timesheet_type: e.timesheetType,
      work_date: e.workDate,
      work_hours: e.hours,
      work_content: e.workContent,
      cost_line_id: e.costLineId,
    };
    if (Number(e.timesheetType) === 2 && Number(e.inProjectId) > 0) {
      entryObj.in_project_id = e.inProjectId;
      entryObj.process_type = e.processType;
    }
    const bodyObj = { user_id: userId, query_params: JSON.stringify({ json_array: [entryObj] }) };
    const { rows, error } = await callPmisApi('111', bodyObj);

    let ok = false;
    let pmisMsg = '';
    if (error) {
      pmisMsg = `MCP 错误：${error}`;
    } else {
      for (const r0 of rows) {
        const hit = Object.entries(r0).find(([k, v]) => k.includes('成功') && k.includes('笔数') && parseInt(v, 10) > 0);
        if (hit) { ok = true; pmisMsg = `成功 ${parseInt(hit[1], 10)} 笔`; break; }
      }
      if (!ok) pmisMsg = rows.length > 0 ? JSON.stringify(rows[0]) : '(无返回)';
    }
    if (ok) okCount++; else failCount++;
    results.push({ hospitalId: e.hospitalId, hospitalName: e.hospitalName, hours: e.hours, ok, message: pmisMsg });
  }

  const allOk = failCount === 0;
  return res.json({
    success: allOk,
    total: entries.length,
    okCount,
    failCount,
    message: allOk ? `✅ 批量提交完成：${okCount} 家全部成功` : `⚠️ 部分失败：成功 ${okCount} 家，失败 ${failCount} 家`,
    results,
  });
});

// 工时工作知识库（Configs/timesheet-kb.json，全局共享）
router.get('/kb', authenticate, (req, res) => res.json(kb.kbAll()));
router.get('/kb-random', authenticate, (req, res) => res.json(kb.kbRandom(parseInt(req.query.count, 10) || 3)));
router.post('/kb-add', authenticate, (req, res) => res.json(kb.kbAdd(req.body?.content)));
router.post('/kb-delete', authenticate, (req, res) => res.json(kb.kbDelete(req.body?.index)));

export default router;
