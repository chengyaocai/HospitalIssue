// WXP 底稿系统客户端（v1.18.42 原生集成）：把 AISkillController 的 WXP 链路移植为 Node 原生实现。
//   pmisLogin / ensurePmisToken     PMIS token 静态缓存（提前 5 分钟过期）+ 加锁自动重登
//   invalidateAndRefresh()          鉴权失效时清缓存立即重登（同一把锁，防并发互踩）
//   queryDraftsForHospital()        拉一家医院的底稿并生成工作内容（单家 + 批量共用核心）
// 请求头（与 C# CreateWxpClientAsync 一致）：X-USER-CODE / X-AGENT-TOKEN(PMIS token) / X-SOURCE: AGENT。
// 并发串行化：WXP 有调用频率限制，全部 WXP 请求经 runExclusive 排队（对齐 C# _wxpSessionLock）。

import { getWxpSettings, getTimesheetFileConfig } from './configs.js';

// ---------- PMIS token 缓存（v1.18.43 起按 WXP 工号隔离：每个公司用户用自己的账号登录） ----------

const SafetyMarginMs = 5 * 60 * 1000; // 提前 5 分钟判定过期
const tokenCaches = new Map(); // userCode -> { token, userCode, userNote, refreshToken, loginAt, expiresAt }

function cacheOf(userCode) {
  if (!tokenCaches.has(userCode)) {
    tokenCaches.set(userCode, { token: null, userCode, userNote: null, refreshToken: null, loginAt: 0, expiresAt: 0 });
  }
  return tokenCaches.get(userCode);
}

function cacheValid(cache) {
  return Boolean(cache.token) && Date.now() < cache.expiresAt - SafetyMarginMs;
}

// 两把独立的 promise 链锁（对齐 C# 的 _pmisRefreshLock 与 _wxpSessionLock 分离）：
//   loginLock —— 登录/重登互斥（同一时刻只有一个 PMIS 登录在跑）
//   queueLock —— WXP 请求串行化（等锁期间取消的请求不再打上游）
// 注意两把锁绝不能嵌套持有（外层 runExclusive 内可安全调 ensurePmisToken）。
let loginLock = Promise.resolve();
function withLoginLock(fn) {
  const run = loginLock.then(fn, fn);
  loginLock = run.catch(() => {});
  return run;
}

let queueLock = Promise.resolve();
export function runExclusive(fn) {
  const run = queueLock.then(fn, fn);
  queueLock = run.catch(() => {});
  return run;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 真正调 pmisLogin。成功写缓存；业务失败（密码错等）不重试；网络异常重试 1 次 */
async function doPmisLogin(userCode, password) {
  const s = getWxpSettings();
  const url = `${s.baseUrl}${s.pmisLoginPath}`;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-SOURCE': 'AGENT' },
        body: JSON.stringify({ userCode: userCode.trim(), password }),
        signal: ctrl.signal,
      });
      const root = await resp.json();
      const code = Number(root.code) || 0;
      const msg = typeof root.message === 'string' ? root.message : '';
      if ((code === 200 || code === 20000) && root.data) {
        const token = typeof root.data.accessToken === 'string' ? root.data.accessToken : null;
        const uc = typeof root.data.userCode === 'string' ? root.data.userCode : null;
        if (token && uc) {
          const expiresIn = Number(root.data.expiresIn) > 0 ? Number(root.data.expiresIn) : 7200;
          const cache = cacheOf(uc);
          cache.token = token;
          cache.userCode = uc;
          cache.userNote = root.data.userNote || uc;
          cache.refreshToken = root.data.refreshToken || null;
          cache.loginAt = Date.now();
          cache.expiresAt = cache.loginAt + expiresIn * 1000;
          return { ok: true, message: msg, token, userCode: uc, userNote: cache.userNote };
        }
      }
      return { ok: false, message: msg || '登录失败', token: null, userCode: null, userNote: null };
    } catch (err) {
      lastError = err?.name === 'AbortError' ? new Error('连接 PMIS 服务器超时（30 秒无响应）') : err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await sleep(1500);
  }
  return {
    ok: false,
    message: lastError
      ? `登录请求异常：${lastError.message || lastError}`
      : '登录失败',
    token: null, userCode: null, userNote: null,
  };
}

export async function pmisLogin(userCode, password) {
  return withLoginLock(() => doPmisLogin(userCode, password));
}

/**
 * 确保 PMIS token 有效（惰性刷新，v1.18.43 起按调用方凭据隔离）。
 * cred = { userCode, password }（生效凭据：个人配置优先，未配置回落全局 Configs，由路由层解析）。
 * 1. 该工号缓存有效 → 直接复用；2. 无缓存 → 加锁自动登录；3. 无凭据 → null
 */
export async function ensurePmisToken(cred) {
  if (!cred || !cred.userCode || !cred.password) return null;
  const cache = cacheOf(cred.userCode);
  if (cacheValid(cache)) return cache.token;
  return withLoginLock(async () => {
    if (cacheValid(cache)) return cache.token; // double-check
    const r = await doPmisLogin(cred.userCode.trim(), cred.password);
    return r.ok ? r.token : null;
  });
}

/** 鉴权失效时调用：清空该工号旧 token 并立即重登（同一把锁内原子完成） */
export async function invalidateAndRefresh(cred) {
  if (!cred || !cred.userCode) return;
  await withLoginLock(async () => {
    const cache = cacheOf(cred.userCode);
    cache.token = null;
    cache.expiresAt = 0;
    if (cred.password) await doPmisLogin(cred.userCode.trim(), cred.password);
  });
}

/** 测试凭据可用性（工时配置页「测试连接」）：登录成功返回 { ok, userCode, userNote } */
export async function testWxpCredential(cred) {
  if (!cred || !cred.userCode || !cred.password) {
    return { ok: false, message: '请先填写工号与密码' };
  }
  const r = await doPmisLogin(cred.userCode.trim(), cred.password);
  return r.ok
    ? { ok: true, userCode: r.userCode, userNote: r.userNote, message: `连接成功：${r.userNote || r.userCode}` }
    : { ok: false, message: r.message || '登录失败（请检查工号与密码）' };
}

// ---------- WXP HTTP ----------

/** 鉴权失败判定（与 C# IsWxpAuthFailure 一致） */
export function isWxpAuthFailure(code, message) {
  if (code === 401 || code === 403) return true;
  const m = String(message || '');
  if (/token|unauthorized/i.test(m)) return true;
  return m.includes('登录已过期') || m.includes('登录失效') || m.includes('授权过期')
    || m.includes('未登录') || m.includes('请先登录');
}

/** 当前 WXP 工号（X-USER-CODE 头 / 底稿归属过滤共用）：即生效凭据的工号 */
export function currentUserCode(cred) {
  return cred?.userCode || '';
}

async function wxpPost(path, body, timeoutMs, cred) {
  const token = await ensurePmisToken(cred);
  if (!token) return { client: null };
  const s = getWxpSettings();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-USER-CODE': cred.userCode,
    'X-AGENT-TOKEN': token,
    'X-SOURCE': 'AGENT',
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${s.baseUrl}${path}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {
      throw new Error(`WXP 接口返回非 JSON 内容（HTTP ${resp.status}，${path}）：${text.slice(0, 200)}`);
    }
    return { client: true, status: resp.status, json, userCode: cred.userCode };
  } finally {
    clearTimeout(timer);
  }
}

/** 我的医院列表（queryMyCustomerList）。返回 { ok, hospitals, authFailed, message } */
export async function queryMyCustomerList(cred, timeoutMs = 30000) {
  const s = getWxpSettings();
  let lastErr = null;
  for (let hi = 0; hi < 2; hi++) {
    try {
      const r = await wxpPost(s.queryMyCustomerListPath, { keyWord: '' }, timeoutMs, cred);
      if (r.client === null) return { ok: false, authFailed: false, hospitals: [], message: '请先在「工时配置」里填写 WXP 工号与密码（且系统默认账号未配置）' };
      const code = Number(r.json?.code) || 0;
      const msg = typeof r.json?.message === 'string' ? r.json.message : '';
      if (isWxpAuthFailure(code, msg)) return { ok: false, authFailed: true, hospitals: [], message: msg };
      if (code !== 20000 || !Array.isArray(r.json?.data)) {
        return { ok: false, authFailed: false, hospitals: [], message: msg || 'WXP 返回异常' };
      }
      const hospitals = r.json.data
        .map((h) => ({ hospitalCode: h.hospitalCode || '', hospitalName: h.hospitalName || '', province: h.province || '', city: h.city || '' }))
        .filter((h) => h.hospitalCode);
      return { ok: true, authFailed: false, hospitals, message: '' };
    } catch (err) {
      lastErr = err;
      if (hi === 0) await sleep(600); // 网络异常重试 1 次
    }
  }
  return { ok: false, authFailed: false, hospitals: [], message: lastErr?.message || '医院列表获取失败' };
}

function pickTitle(item) {
  const t = typeof item.title === 'string' ? item.title : '';
  if (t) return t;
  return typeof item.description === 'string' ? item.description : '';
}

/**
 * 查一家医院的底稿 + 生成工作内容（单家 + 批量两个接口共用的核心逻辑）。
 * 返回 null 表示鉴权失败需整批重试；其他错误直接 throw。
 */
/**
 * 查一家医院的底稿 + 生成工作内容（单家 + 批量两个接口共用的核心逻辑）。
 * binding = { hospitalName?, draftViewId? }（个人绑定优先、回落全局，由路由层解析）。
 * 返回 null 表示鉴权失败需整批重试；其他错误直接 throw。
 */
export async function queryDraftsForHospital({ cred, hospitalId, hospitalName, workDate, includeInProgress, binding }) {
  const s = getWxpSettings();
  const body = { hospitalId };
  if (binding?.draftViewId) body.viewId = binding.draftViewId;

  const r = await wxpPost(s.draftListPath, body, 60000, cred);
  if (r.client === null) throw new Error('请先在「工时配置」里填写 WXP 工号与密码（且系统默认账号未配置）');
  const root = r.json || {};
  const code = Number(root.code) || 0;
  const msg = typeof root.message === 'string' ? root.message : '';
  const hName = binding?.hospitalName || hospitalName || hospitalId;
  const userCode = cred?.userCode || '';
  if (isWxpAuthFailure(code, msg)) return null;
  // WXP 业务/服务端错误（如 code=40000 服务器内部错误）不能静默当成"0 底稿"
  if (code !== 20000) {
    throw new Error(`底稿接口返回错误（${hName}，HTTP ${r.status}，code=${code}）：${msg.slice(0, 150)}`);
  }

  const data = root.data;
  const arr = Array.isArray(data) ? data : (Array.isArray(data?.list) ? data.list : []);

  const inProgressStatus = Array.isArray(getTimesheetFileConfig().InProgressStatusList)
    ? getTimesheetFileConfig().InProgressStatusList : [];
  const mine = [];
  const closedToday = [];
  const inProgress = [];

  for (const item of arr) {
    const implMgr = typeof item.implementManager === 'string' ? item.implementManager : '';
    if (!implMgr.includes(userCode)) continue;
    mine.push(item);

    const statusName = typeof item.statusName === 'string' ? item.statusName : '';
    const closeTime = (typeof item.closeTime === 'string' && item.closeTime)
      ? item.closeTime : (typeof item.updatedTime === 'string' ? item.updatedTime : '');
    const closeDay = closeTime.length >= 10 ? closeTime.slice(0, 10) : '';
    const reportDay = workDate && workDate.length >= 10 ? workDate.slice(0, 10) : (workDate || '');
    const closedInRange = statusName === '已关闭' && closeDay && reportDay && closeDay === reportDay;

    if (closedInRange) closedToday.push(item);
    else if (inProgressStatus.includes(statusName)) inProgress.push(item);
  }

  const lines = [`【AI工时】${hName}运维支持工作：`];
  let idx = 1;
  if (closedToday.length > 0) {
    lines.push(`【当天完成】(${closedToday.length}项)`);
    for (const draft of closedToday) {
      const title = pickTitle(draft);
      if (title) lines.push(`${idx++}.${title}(已关闭)`);
    }
  }
  if (inProgress.length > 0 && includeInProgress) {
    const shown = inProgress.slice(0, 3); // 进行中仅取前 3 项，避免内容过长
    lines.push(`【进行中】(${inProgress.length}项，展示前${shown.length}项)`);
    for (const draft of shown) {
      const title = pickTitle(draft);
      const status = typeof draft.statusName === 'string' ? draft.statusName : '';
      if (title) lines.push(`${idx++}.${title}(${status})`);
    }
  }
  lines.push(`累计处理${mine.length}项底稿`);

  const topDrafts = closedToday.concat(inProgress).map((m) => ({
    title: typeof m.title === 'string' ? m.title : '',
    statusName: typeof m.statusName === 'string' ? m.statusName : '',
    closeTime: typeof m.closeTime === 'string' ? m.closeTime : '',
  }));

  return {
    hospitalName: hName,
    mineCount: mine.length,
    closedTodayCount: closedToday.length,
    inProgressCount: inProgress.length,
    workContent: lines.join('\n') + '\n',
    topDrafts,
  };
}
