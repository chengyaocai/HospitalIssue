# 多机构（多院区）模式方案

> 面向「海盐县人民医院信息科软件问题登记程序」由单机构升级为**多机构**的设计方案。
> 基线：Node/Express + Vue3，生产 SQL Server（mssql 纯 JS 驱动），dev 用本地 JSON；角色权限动态化、设置存 `app_setting`、JWT 仅含 role。

---

## 0. 一页结论（TL;DR）

- **推荐「单实例 + 单库 + 行级 org_id 隔离」**：一套部署、一个库，全部业务数据加 `org_id`，由中间件统一注入机构范围（**deny-by-default**）。
- 用户是**全局账号**，通过成员关系表 `app_user_org` 表达「属于哪些机构、在该机构的角色」；JWT 携带当前机构；UI 提供**机构切换**（仅一个机构时不显示）。
- 系统设置（部门/软件系统/处理人/角色权限/系统名）**按机构**存储。
- **平台管理员**可跨机构查看与统一驾驶舱；**机构管理员**只能管本院。
- 现有单院数据**平滑升级**：新建默认机构，历史数据全量回填，单机构形态下体验与现状完全一致。

---

## 1. 背景与目标

**现状**：单机构——单一部署、单一数据库，`app_setting` 是全库唯一 KV，权限矩阵全局一份，JWT 只带 `role`。

**诉求**：用户实际管理多家医院（海盐县人民医院、中医院、妇幼保健院…），希望：
1. 各院数据相互隔离，各自独立管理人员 / 权限 / 字典 / 问题；
2. 一套系统统一运维，避免维护 N 套；
3. （可选）在授权下做跨院统一分析与对比。

**目标（In scope）**
- 数据隔离：任意接口 / 导出 / 附件 / 统计**不得越界**。
- 身份与权限：一个人可在多院任职、角色可不同；平台级与机构级两级管理员。
- 设置按机构隔离；支持机构级品牌名 / 字典。
- 平滑迁移与灰度；单机构形态下功能不回退。

**非目标（Out of scope，可后续）**
- 机构间工单流转 / 转派；跨机构消息；SaaS 计费；每院独立域名与完全独立品牌。

---

## 2. 关键设计决策（选项对比）

### 2.1 隔离模型
| 方案 | 说明 | 隔离强度 | 开发量 | 运维成本 | 跨院分析 |
|---|---|---|---|---|---|
| A 多实例 | 每院独立部署 + 独立库 | 最高 | 最低 | **N×，最重** | 不支持 |
| **B 单实例单库（行级 `org_id`）** ✅ | 一套部署一个库，业务表加 `org_id` | 依赖应用层（可做到强） | 中 | **最轻** | 支持 |
| C 单实例多库 | 一套进程，每院一个 database，按机构路由连接池 | 高（库级） | 中高 | 中 | 需跨库聚合，较难 |
| D 单实例多 schema | 同库多 schema | 中高 | 高（改造重） | 中 | 同库可聚合 |

**推荐 B**：改造面可控、运维最轻、天然支持跨院统计；隔离靠「统一注入 + 默认拒绝 + 跨机构负例测试」保证。
若院方**合规**要求库级/物理隔离，退而选 **C**（进程内按机构切换连接池，代码里仍是"一处注入 orgId"的同构改法）。

### 2.2 用户与身份模型
- **全局账号**：`app_user` 保留 `username UNIQUE`，登录不歧义，规避跨院同名账号冲突。
- **成员关系表** `app_user_org(user_id, org_id, role, is_default, active)`：一人可属多院、各院角色可不同。
- **平台管理员**：`app_user.is_platform_admin = 1`，可跨院查看与维护机构。
- 备选（更省事但受限）：`app_user.org_id` 单字段 → 一人只能属一院；无法支持"跨院总管理员"。**推荐成员关系表**。

### 2.3 角色与权限
- 角色/权限**目录**（`MENUS`/`ACTIONS`）保持代码常量、全局定义不变；
- **授权矩阵按机构存**（每院一套 `roles` + `permissions`），不同院可用不同角色集；
- 内置角色（admin/reporter）在每个机构自动存在；机构管理员可自定义本院角色；
- 平台管理员是跨机构身份，**不进**任何机构的权限矩阵。

### 2.4 机构上下文传递
- 登录成功返回可访问机构列表；>1 时前端选择并记忆当前机构；
- JWT 声明：`org`（当前机构 id）、`platform`（布尔）；
- `POST /api/auth/switch-org { orgId }` 校验成员关系后**重签 token**；
- 所有 `/api/*` 经 `tenant` 中间件解析 `req.orgId`；平台管理员可用 `X-Org-Id` / `?org=` 指定查看目标机构；
- **写接口无明确 org → 400**；跨机构"汇总"语义需显式 `scope=all` 且仅平台管理员可用。

---

## 3. 数据模型

### 3.1 新增表
**`app_org`（机构）**
| 字段 | 类型 | 说明 |
|---|---|---|
| id | BIGINT IDENTITY PK | |
| code | NVARCHAR(30) UNIQUE | 机构编码，如 `HYRMYY`/`ZYY`/`FYBJY` |
| name | NVARCHAR(100) | 机构全称 |
| short_name | NVARCHAR(50) | 简称（切换器显示） |
| active | BIT DEFAULT 1 | 停用标记 |
| sort | INT DEFAULT 0 | 排序 |
| created_at | DATETIME | |

**`app_user_org`（用户-机构成员关系）**
| 字段 | 类型 | 说明 |
|---|---|---|
| id | BIGINT IDENTITY PK | |
| user_id | BIGINT | → `app_user.id` |
| org_id | BIGINT | → `app_org.id` |
| role | NVARCHAR(30) | 该机构内角色 key |
| is_default | BIT | 默认登录机构 |
| active | BIT DEFAULT 1 | |
| | | `UNIQUE(user_id, org_id)` |

**`app_org_setting`（机构级设置）**：`org_id BIGINT, [key] NVARCHAR(50), [value] NVARCHAR(MAX), PK(org_id,[key])`
> 现有 `app_setting` 是全库唯一 KV，多机构下要么加 `org_id` 改复合主键，要么新建 `app_org_setting` 并迁移存量。**推荐新建 `app_org_setting`**，保留 `app_setting` 仅存**平台级**配置（如全局开关、平台策略）。

### 3.2 现有表加列（一律 `IF NOT EXISTS … ALTER TABLE` 平滑迁移）
| 表 | 新增列 | 说明 |
|---|---|---|
| software_issue | `org_id BIGINT` | 问题归属；建索引 `(org_id, status)`、`(org_id, created_at)` |
| audit_log | `org_id BIGINT NULL` | 审计归属；平台级操作记 NULL 或平台标记 |
| app_notification | `org_id BIGINT` | 通知归属；广播仅本院 |
| duty_schedule | `org_id BIGINT` | 排班归属 |
| app_chat_conversation | `org_id BIGINT` | 会话归属；成员须同院 |
| app_chat_message | 不加列 | 经会话 join 取 org |
| app_user | `is_platform_admin BIT DEFAULT 0` | 平台超管标记 |

> 迁移期：以「默认机构 id」为 `org_id` 的 `DEFAULT` 回填存量；迁完后由应用**强制写入**，DB 约束可选保留。

### 3.3 迁移脚本要点（幂等，可重复执行）
1. `CREATE TABLE app_org` + 插入默认机构（海盐县人民医院）。
2. 各业务表 `ADD org_id` → `UPDATE … SET org_id = @defaultOrg WHERE org_id IS NULL`。
3. 建 `app_user_org`，把现存 `app_user.role` 迁成"默认机构成员关系"；给原 `admin` 打 `is_platform_admin=1`。
4. `app_setting` 的 `appName/handlers/softwareSystems/roles/permissions` 整表搬入 `app_org_setting`（org=默认机构）。
5. 每一步 `IF NOT EXISTS` / 判空；迁移后校验：各表 `org_id` 非空行数 = 总行数。

---

## 4. 鉴权与租户上下文（后端）

- `auth/jwt.js`：token 增加 `org`、`platform` 声明。
- 新增 `auth/tenant.js`（在 `authenticate` 之后）：
  - 取 token 的 `org`，平台管理员允许 `X-Org-Id`/`?org=` 覆盖（校验机构存在且 active）；
  - 设置 `req.orgId` / `req.isPlatformAdmin`；**业务写接口无 orgId → 400**。
- `routes/auth.js`：
  - 登录：查 `app_user_org` 得机构列表（含角色）；返回 `orgs:[{id,name,role,isDefault}]`；无成员但平台管理员 → 平台视角；
  - `POST /auth/switch-org { orgId }`：校验成员关系 → 重签 token；
  - `GET /auth/me`：返回当前机构 + 机构列表。
- `auth/authorize.js`：`requirePermission(action)` 改为**按 `req.orgId` 取该机构该角色的权限**（权限来源从"全局"改"机构"）。
- `permissions.js`：`permissionsFor(perms, role)` 逻辑不变，`perms` 改为从**机构设置**加载。

---

## 5. 系统设置按机构（后端）

- `settings/index.js`：`getSettings(orgId)` / `updateSettings(orgId, patch)`，底层 `app_org_setting`。
- **锁定保护按机构**：每个机构都必须保留"至少一个角色同时具备 `user.manage`+`settings.edit`"；平台级另需至少一个平台管理员（防止把自己锁在门外）。
- `GET /api/config`：登录后按当前机构返回；未登录（登录页）只返回**最小公共配置**（平台名 + 机构 code/name 列表，供选择）。

---

## 6. 模块级收敛清单（全部按 `orgId` 过滤/校验）

| 模块 | 关键改动 |
|---|---|
| **problems** | `list/get/create/update/delete/restore/hard/bulk/dashboard/trend/export` 全部加 `org_id=@org`；详情/编辑/删除前先校验归属 |
| **audit** | 写入带 `org_id`；查询按 org（平台管理员可跨机构）；导出同 |
| **notifications** | 广播扇出**仅限本院 active 用户**；列表/未读按 org；发送/广播权限按机构 |
| **schedules** | 全部按 org |
| **chat** | 会话带 org；新建会话成员**限定同院**；AI 会话按 `(org,user)`；发消息/上传附件的成员校验加 org |
| **users** | 机构管理员只能管理**本院成员**；新建用户默认加入本院；角色下拉取本院角色集 |
| **settings** | 按机构读写 |
| **uploads（附件）** | 存储路径 `uploads/<orgId>/`；下载/预览前校验附件所属 org 与调用者一致 |

---

## 7. 前端改造

- `api.js`：请求带 `X-Org-Id`（token 已含 org 时可不带）；新增 `switchOrg`。
- 新增 **`OrgSwitcher.vue`**：侧栏显示当前机构简称，下拉列出可访问机构；**仅 1 个机构时隐藏**，单机构体验不变。
- 登录后若多机构：登录页（或首屏）选择机构。
- 菜单/权限按**当前机构角色**计算（`/api/config` 已按机构返回）。
- 页面标题与品牌名用当前机构 `appName`。
- 新增 **`OrgManage.vue`（机构管理页，平台管理员）**：增 / 改 / 停用机构、编码简称排序。
- **跨机构驾驶舱（可选）**：`Cockpit` 增加「本院 / 全院汇总」切换，仅平台管理员可见。
- 切换机构后清空列表缓存并重新拉取（复用现有 `loadForView` + `watch(myPerms)` 回退逻辑）。

---

## 8. 跨机构统计（可选能力）

- 仅平台管理员：`GET /api/problems/dashboard?scope=all` → 按 org 分组聚合再给合计。
- 导出支持"分机构册"（每院一个 sheet）或"跨机构汇总"。
- **默认（不传 scope）恒为"本院"**，避免误看他人数据。

---

## 9. 风险与缓解（重点）

| 风险 | 缓解 |
|---|---|
| **跨机构越权 / 数据泄漏（头号风险）** | 机构过滤**只在仓储层统一注入**（禁止各路由手写 where）；`authenticate→tenant` 两级中间件强制 orgId；**跨机构负例测试**（用 B 院 token 访问 A 院记录必须 404/403）纳入 CI |
| 迁移中数据错配 | 迁移脚本幂等 + 回填校验（各表 `org_id` 非空计数 = 总行数）；先在测试库演练 |
| 平台管理员误操作 | 平台级操作写审计并标记平台；高风险操作二次确认 |
| 缓存串味 | 设置/角色缓存 key 含 `orgId`；切换机构时前端清缓存 |
| 存量耦合大 | 后端先做"orgId 可选、单机构自动注入"过渡，前端分步接入 |
| 通知/聊天广播越界 | 扇出与成员校验显式带 org；广播仅本院 |

---

## 10. 分阶段实施计划

| 阶段 | 内容 | 交付物 | 验收标准 |
|---|---|---|---|
| **P0 决策冻结** | 确认隔离模型 / 身份模型 / 是否要跨院分析 | 本方案定稿 | 三项决策确认 |
| **P1 数据层** | `app_org`/`app_user_org`/`app_org_setting`；业务表加 `org_id`；迁移脚本 | DDL + 迁移脚本 + 演练报告 | 测试库迁移幂等、回填 100% |
| **P2 鉴权上下文** | JWT 带 org、`tenant` 中间件、`switch-org`、多机构登录 | 后端接口 + 测试 | A/B 院隔离负例全过 |
| **P3 模块收敛** | 6 大模块按 org 收敛（problems/audit/notifications/schedules/chat/users/settings） | 代码 + 回归 | 全量接口按 org 正确；回归全绿 |
| **P4 前端** | 机构切换器、机构管理页、按机构菜单/标题 | 前端构建 | 切换机构后数据正确切换 |
| **P5 跨院分析(可选)** | 汇总驾驶舱 / 分机构导出 | 前端 + 接口 | 仅平台管理员可见 |
| **P6 迁移上线** | 生产迁移 + 灰度 + 文档 | 增量部署包 + 升级说明 | 现网数据无损、单院体验不变 |

---

## 11. 部署与运维

- 仍是**单实例、单库**；无需改 Windows 任务计划 / 端口。
- 首次升级执行一次迁移脚本（幂等）；`schema.sql` 同步更新（新增表/列）。
- 单机构下切换器隐藏，体验与现状一致；平台管理员由原 `admin` 在迁移时指定。

---

## 12. 待决策项（请确认）

1. **隔离模型**：B 行级（推荐）/ A 多实例 / C 多库
2. **用户身份**：全局账号 + 成员关系（推荐，支持一人多院）/ 一人一院
3. **是否需要「跨机构统一驾驶舱」**（平台管理员可见）？
4. **首期机构范围**：先 2 家试点，还是一次铺 3 家？
