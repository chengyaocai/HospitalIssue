import express from 'express';
import { getScheduleStore } from '../schedules/index.js';
import { isDateStr } from '../schedules/dateUtil.js';
import { authenticate } from '../auth/middleware.js';
import { requirePermission, isPlatformAdmin } from '../auth/authorize.js';
import { getOrgStore } from '../orgs/index.js';
import { audit } from '../audit/index.js';
import { send500 } from '../errors.js';

const router = express.Router();

function str(v, max) {
  const s = String(v ?? '').trim();
  return max ? s.slice(0, max) : s;
}

// 从请求体取排班字段并做基础校验，返回 { error } 或字段对象。
function parseBody(body) {
  const date = str(body.date, 10);
  const handlerName = str(body.handlerName, 100);
  const handlerUsername = str(body.handlerUsername, 50);
  const note = str(body.note, 200);
  if (!isDateStr(date)) return { error: '日期格式应为 YYYY-MM-DD（且为真实日期）' };
  if (!handlerName) return { error: '值班人姓名必填' };
  return { date, handlerName, handlerUsername, note };
}

// 查看排班：任何登录用户均可（值班表对全员只读开放，同消息通知）。
// query: from / to（YYYY-MM-DD，均可选，含端点）。
router.get('/', authenticate, async (req, res) => {
  try {
    const from = str(req.query.from, 10);
    const to = str(req.query.to, 10);
    if (from && !isDateStr(from)) return res.status(400).json({ error: 'from 日期格式应为 YYYY-MM-DD' });
    if (to && !isDateStr(to)) return res.status(400).json({ error: 'to 日期格式应为 YYYY-MM-DD' });
    const store = await getScheduleStore();
    res.json(await store.listRange(from || undefined, to || undefined, req.orgId));
  } catch (e) {
    send500(res, e);
  }
});

// 以下写操作均需「排班管理」功能权限。
router.use(authenticate, requirePermission('schedule.manage'));

// 新增排班：同日同人（有账号按账号判重，无账号按姓名）返回 409。
router.post('/', async (req, res) => {
  try {
    const parsed = parseBody(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const store = await getScheduleStore();
    const sameDay = await store.listRange(parsed.date, parsed.date, req.orgId);
    const dup = sameDay.find((x) =>
      parsed.handlerUsername ? x.handlerUsername === parsed.handlerUsername : x.handlerName === parsed.handlerName);
    if (dup) return res.status(409).json({ error: '该日已排此人' });
    const rec = await store.create({ ...parsed, createdBy: req.user.username, org_id: req.orgId });
    await audit({
      username: req.user.username,
      action: 'CREATE_SCHEDULE',
      target: parsed.handlerName,
      detail: `${parsed.date}${parsed.note ? ' 备注:' + parsed.note : ''}`,
    });
    res.status(201).json(rec);
  } catch (e) {
    send500(res, e);
  }
});

// 修改排班：id 不存在返回 404；改后的「同日同人」查重排除自身。
router.put('/:id', async (req, res) => {
  try {
    const parsed = parseBody(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const store = await getScheduleStore();
    const existing = await store.findById(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: '排班记录不存在' });
    const sameDay = (await store.listRange(parsed.date, parsed.date, req.orgId))
      .filter((x) => String(x.id) !== String(existing.id));
    const dup = sameDay.find((x) =>
      parsed.handlerUsername ? x.handlerUsername === parsed.handlerUsername : x.handlerName === parsed.handlerName);
    if (dup) return res.status(409).json({ error: '该日已排此人' });
    const rec = await store.update(existing.id, parsed, req.orgId);
    await audit({
      username: req.user.username,
      action: 'UPDATE_SCHEDULE',
      target: parsed.handlerName,
      detail: `${existing.date} ${existing.handlerName} -> ${parsed.date} ${parsed.handlerName}`,
    });
    res.json(rec);
  } catch (e) {
    send500(res, e);
  }
});

// 删除排班：id 不存在返回 404。
router.delete('/:id', async (req, res) => {
  try {
    const store = await getScheduleStore();
    const existing = await store.findById(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: '排班记录不存在' });
    await store.remove(existing.id, req.orgId);
    await audit({
      username: req.user.username,
      action: 'DELETE_SCHEDULE',
      target: existing.handlerName,
      detail: `${existing.date} ${existing.handlerName}`,
    });
    res.json({ ok: true });
  } catch (e) {
    send500(res, e);
  }
});

// 复制上周排班到本周（也可以是任意两个周一）：跳过目标周「同日同人」已存在的。
router.post('/copy-week', async (req, res) => {
  try {
    const body = req.body || {};
    const sourceFrom = str(body.sourceFrom, 10);
    const targetFrom = str(body.targetFrom, 10);
    if (!isDateStr(sourceFrom)) return res.status(400).json({ error: 'sourceFrom 日期格式应为 YYYY-MM-DD' });
    if (!isDateStr(targetFrom)) return res.status(400).json({ error: 'targetFrom 日期格式应为 YYYY-MM-DD' });
    const store = await getScheduleStore();
    const r = await store.copyWeek(sourceFrom, targetFrom, req.orgId);
    await audit({
      username: req.user.username,
      action: 'COPY_SCHEDULE',
      target: 'duty_schedule',
      detail: `${sourceFrom} -> ${targetFrom} copied=${r.copied}`,
    });
    res.json(r);
  } catch (e) {
    send500(res, e);
  }
});

// 跨机构同步排班（v1.18.13 新增；v1.18.18 升级为「带来源标记的镜像同步」，仅平台管理员 ——
// isPlatformAdmin 以库为准，放在 schedule.manage 之后）：
//   push = 把当前机构 [from,to] 的排班镜像到 orgIds 里每个其他机构；
//   pull = 把 orgIds 里每个机构的排班镜像到当前机构。
// 镜像语义（把目标时段与源对齐），对每个 (源机构 → 目标机构)：
//   ① 新增 copied：源有、目标没有「同日同人」键 → 创建（打 synced=1 标记，登记人=操作者）；
//   ② 更新 updated：同键条目内容（账号/姓名/备注，规范化后全等）不一致 → 用源内容更新目标
//      —— **不分 synced 标记**（v1.18.13 时代的无标记存量同步条目与手工条目都参与对齐；
//      但对齐不改变条目自身的 synced 标记：手工条目被对齐后仍视为手工）；
//   ③ 不变 unchanged：同键且内容一致；
//   ④ 移除 removed（保守）：目标中 **synced=1（上次同步产生）** 且源里已无该键的条目 → 删除；
//      synced=0（手工 / 复制周）条目**永不被移除**，键不匹配时完全不动。
// 返回 { results:[{orgId, copied, updated, removed, unchanged}], totalCopied, totalUpdated,
//        totalRemoved, totalUnchanged }；相同数据重复同步幂等（全为 unchanged）。
const SYNC_KEY = (e) => `${e.date}|${e.handlerUsername || e.handlerName}`;
router.post('/sync', async (req, res) => {
  try {
    if (!(await isPlatformAdmin(req))) {
      return res.status(403).json({ error: '仅平台管理员可跨机构同步排班' });
    }
    const body = req.body || {};
    const direction = String(body.direction || '');
    if (direction !== 'push' && direction !== 'pull') {
      return res.status(400).json({ error: 'direction 应为 push（推送到其他机构）或 pull（从其他机构拉取）' });
    }
    const from = str(body.from, 10);
    const to = str(body.to, 10);
    if (!from) return res.status(400).json({ error: 'from 必填（YYYY-MM-DD）' });
    if (!to) return res.status(400).json({ error: 'to 必填（YYYY-MM-DD）' });
    if (!isDateStr(from)) return res.status(400).json({ error: 'from 日期格式应为 YYYY-MM-DD' });
    if (!isDateStr(to)) return res.status(400).json({ error: 'to 日期格式应为 YYYY-MM-DD' });
    if (from > to) return res.status(400).json({ error: 'from 不能晚于 to' });
    if (!Array.isArray(body.orgIds) || body.orgIds.length === 0) {
      return res.status(400).json({ error: 'orgIds 应为非空的机构 id 数组' });
    }
    if (body.orgIds.length > 20) {
      return res.status(400).json({ error: 'orgIds 一次最多选择 20 个机构' });
    }
    // 去重，并过滤掉当前机构自己（push 的目标 / pull 的来源都不该是本机构，避免自我复制）。
    const orgIds = [...new Set(body.orgIds.map((n) => String(Number(n))))]
      .filter((id) => id !== 'NaN' && id !== String(req.orgId));
    // 机构有效性：目标 / 来源机构必须存在且未停用。
    const orgStore = await getOrgStore();
    for (const id of orgIds) {
      const org = await orgStore.get(id);
      if (!org || org.active === false) {
        return res.status(400).json({ error: `机构不存在或已停用：id=${id}` });
      }
    }
    const store = await getScheduleStore();
    // push：一个源（当前机构）对多个目标；pull：多个源对一个目标（当前机构）。
    const pairs = direction === 'push'
      ? orgIds.map((t) => ({ sourceOrg: req.orgId, targetOrg: t }))
      : orgIds.map((s) => ({ sourceOrg: s, targetOrg: req.orgId }));
    const createdAt = new Date().toISOString();
    const results = [];
    let totalCopied = 0;
    let totalUpdated = 0;
    let totalRemoved = 0;
    let totalUnchanged = 0;
    for (const { sourceOrg, targetOrg } of pairs) {
      const source = await store.listRange(from, to, sourceOrg);
      const target = await store.listRange(from, to, targetOrg);
      const sourceKeys = new Set(source.map(SYNC_KEY));
      // 目标键 → 条目映射，在 pairs 循环内现查现累积 —— pull 多来源时，后到的来源会看到
      // 先前来源刚写入的条目，跨来源同日同人只落一条（内容相同 → unchanged）。
      const byKey = new Map(target.map((t) => [SYNC_KEY(t), t]));
      let copied = 0;
      let updated = 0;
      let removed = 0;
      let unchanged = 0;
      // ① 新增 + ② 同键对齐更新 + ③ 不变。
      for (const e of source) {
        const key = SYNC_KEY(e);
        const t = byKey.get(key);
        if (!t) {
          const rec = await store.create({
            org_id: targetOrg,
            date: e.date,
            handlerUsername: e.handlerUsername || '',
            handlerName: e.handlerName || '',
            note: e.note || '',
            createdBy: req.user.username,
            createdAt,
            synced: 1, // 同步产生的条目打来源标记，之后才允许被镜像移除
          });
          byKey.set(key, rec);
          copied++;
          continue;
        }
        const same =
          (t.handlerUsername || '') === (e.handlerUsername || '') &&
          (t.handlerName || '') === (e.handlerName || '') &&
          (t.note || '') === (e.note || '');
        if (same) { unchanged++; continue; }
        const patch = {
          handlerUsername: e.handlerUsername || '',
          handlerName: e.handlerName || '',
          note: e.note || '',
        };
        // 只有「本来就是同步产生」的条目保持标记；手工条目被对齐后仍视为手工（永不被镜像删除）。
        if (t.synced) patch.synced = 1;
        const nt = await store.update(t.id, patch, targetOrg);
        byKey.set(key, nt || { ...t, ...patch });
        updated++;
      }
      // ④ 镜像移除（保守）：仅删除「上次同步产生」（synced=1）且源里已无该键的条目。
      for (const t of target) {
        if (!t.synced || sourceKeys.has(SYNC_KEY(t))) continue;
        await store.remove(t.id, targetOrg);
        removed++;
      }
      results.push({ orgId: targetOrg, copied, updated, removed, unchanged });
      totalCopied += copied;
      totalUpdated += updated;
      totalRemoved += removed;
      totalUnchanged += unchanged;
    }
    await audit({
      username: req.user.username,
      action: 'SYNC_SCHEDULE',
      target: 'duty_schedule',
      detail: `${direction} ${from}~${to} orgIds=[${orgIds.join(',')}] copied=${totalCopied} updated=${totalUpdated} removed=${totalRemoved} unchanged=${totalUnchanged}`,
    });
    res.json({ results, totalCopied, totalUpdated, totalRemoved, totalUnchanged });
  } catch (e) {
    send500(res, e);
  }
});

export default router;
