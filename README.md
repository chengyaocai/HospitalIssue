# 医院信息科 · 软件问题登记程序

面向医院信息科的「软件问题登记」内部工具：统一收集、跟踪各科室报来的软件系统**故障 / 需求 / 咨询**类问题，支持筛选、统计与导出（Excel / CSV），便于信息科运维与向院领导汇报。

- **前端**：Vue 3 + Vite（单页应用）
- **后端**：Node.js + Express（REST API + 静态托管）
- **存储**：SQL Server（`mssql` / `tedious`，生产）；内置 **dev 模式（本地 JSON 文件）** 可零数据库直接跑通
- **能力**：登录鉴权（JWT）· 多角色权限（管理员 / 登记员）· 账号改密 / 停用 · 问题附件上传 · 操作审计日志（筛选 / 导出）· 左侧导航 + 深/浅主题 · **系统名称可配置** · 问题筛选 / 排序 / 列自定义 / 详情抽屉 / **批量操作** / 统计 / 导出（Excel、CSV，含导出条件说明）

---

## 目录结构

```
信息科登记问题程序/
├─ prd.md                 # 产品需求文档（简单 PRD）
├─ architecture.md        # 架构设计与任务分解
├─ README.md
├─ backend/               # 后端
│  ├─ package.json
│  ├─ .env.example
│  ├─ schema.sql          # SQL Server 建表 DDL
│  ├─ src/
│  │  ├─ index.js         # Express 入口（挂载各路由 + 静态托管）
│  │  ├─ config.js        # 配置（含 APP_NAME / SETTINGS_DEV_PATH）
│  │  ├─ validators.js
│  │  ├─ db/              # 仓库抽象：devRepo(文件) / mssqlRepo(SQL Server) / sort(排序) / index(工厂)
│  │  ├─ auth/            # 鉴权：middleware / authorize / usersDev / usersMssql
│  │  ├─ audit/           # 审计：devAuditStore / mssqlAuditStore / index(工厂)
│  │  ├─ settings/        # 系统设置：devSettingsStore / mssqlSettingsStore / index(工厂)
│  │  ├─ services/        # uploads.js(附件存取 + 删除清理) · export.js(xlsx / csv 导出)
│  │  └─ routes/          # problems · attachments · auth · users · audit · settings
│  └─ test/api.test.mjs   # 端到端测试
└─ frontend/              # 前端 Vue3 + Vite
   ├─ package.json
   ├─ vite.config.js
   ├─ index.html
   └─ src/
      ├─ App.vue          # 左侧导航布局 + 主题切换 + 品牌名联动
      ├─ api.js
      ├─ styles.css
      └─ components/      # Login · ProblemList · ProblemForm · ProblemDetail(抽屉) · UserManage · AuditLog · ChangePassword · Settings
```

---

## 环境要求

- Node.js ≥ 18（推荐 20+）
- 生产部署需 **SQL Server**（2008+ / 2012+ 推荐，分页用到 `OFFSET FETCH`）
- 仅本地体验 / 演示：无需数据库（dev 模式）

---

## 快速开始（dev 模式，零数据库）

```bash
# 1) 后端
cd backend
cp .env.example .env        # 默认 DB_DRIVER=dev
npm install
npm start                  # 监听 http://localhost:3000

# 2) 前端（另开一个终端）
cd frontend
npm install
npm run dev                # Vite 开发服务器 http://localhost:5173
```

开发时前端通过 Vite 代理把 `/api` 转发到后端 `http://localhost:3000`。

> dev 模式数据存于 `backend/data/issues.json`，可直接查看 / 备份。

---

## 生产模式（连接 SQL Server）

1. 准备数据库与账号，例如建库 `HospitalIssue`。
2. 执行 `backend/schema.sql` 建表（后端首次启动也会自动建表）。
3. 修改 `backend/.env`：

```ini
PORT=3000
DB_DRIVER=mssql
MSSQL_SERVER=10.0.0.5
MSSQL_PORT=1433
MSSQL_DATABASE=HospitalIssue
MSSQL_USER=sa
MSSQL_PASSWORD=你的密码
MSSQL_ENCRYPT=false
MSSQL_TRUST_CERT=true
```

4. 构建前端并由后端同源托管（推荐，免跨域）：

```bash
cd frontend && npm install && npm run build   # 产出 frontend/dist
cd ../backend && npm install && npm start       # 自动托管 dist，访问 http://localhost:3000
```

此时直接访问 `http://localhost:3000` 即为完整应用。

---

## 登录鉴权

除 `/api/auth/login` 与 `/api/health` 外，所有「问题」接口均需登录（JWT Bearer Token）。

- 首次启动自动创建管理员账号：用户名 `admin` / 密码 `admin123`（dev 与 mssql 两种模式均生效；用户存于 `backend/data/users.json` 或 SQL Server 的 `app_user` 表）。
- 前端登录后 token 存于浏览器 `localStorage`，默认 12 小时过期，过期后自动跳回登录页。
- ⚠️ **生产务必修改**：`.env` 中 `JWT_SECRET`（设为强随机串）、`ADMIN_PASSWORD`（改掉默认密码）；如用 SQL Server，同时改 `ADMIN_USER` / `ADMIN_NAME`。

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/auth/login` | 登录，返回 `token` 与 `user` |
| GET | `/api/auth/me` | 校验 token，返回当前登录用户 |

## REST API

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/health` | 健康检查（返回当前 driver） |
| GET | `/api/problems?status=&type=&department=&keyword=&sort=&order=&page=&pageSize=` | 列表（分页 + 筛选 + 排序） |
| GET | `/api/problems/stats` | 统计（按状态 / 类型 / 科室计数） |
| GET | `/api/problems/export?format=xlsx\|csv&...` | 导出（支持同款筛选 + 排序参数） |
| GET | `/api/problems/:id` | 详情 |
| POST | `/api/problems` | 新增 |
| PUT | `/api/problems/:id` | 更新 |
| DELETE | `/api/problems/:id` | 删除（管理员，同时清理附件文件） |
| POST | `/api/problems/bulk/status` | 批量改状态（`{ ids: [], status }`，单次 ≤ 200 条） |
| POST | `/api/problems/bulk/delete` | 批量删除（管理员，`{ ids: [] }`，同时清理附件文件） |

字段：title、department、reporter、contact、type(故障/需求/咨询/其他)、severity(低/中/高/紧急)、status(待处理/处理中/已解决/已关闭)、description、handler、resolution。

---

## 角色 / 附件 / 审计 / 系统设置

**界面**：登录后为**左侧导航**布局——「问题登记 / 用户管理 / 操作日志 / 系统设置」（后三者按角色显示），侧栏底部显示当前用户、修改密码与退出；侧栏品牌名、页面标题均取自可配置的系统名称。

右侧内容区采用统一的「页头 → 指标 → 筛选 → 列表」四段式排版：
- **页头**：页面标题 + 一句话说明，操作按钮（登记 / 导出）右对齐。
- **指标面板**：单卡片 9 等分网格（总计 / 4 个状态 / 4 个类型），数字按类别着色、带圆点图例，随窗口宽度自适应换行。
- **筛选栏**：每个条件带字段标签（状态 / 类型 / 科室 / 关键字），搜索与重置右对齐。
- **列表**：卡片带标题行（名称 + 共 N 条 + **列设置**），**表头可点排序**（再点一次反向），行悬停高亮、操作列右对齐；空态给出图标与下一步提示；分页「左侧统计 + 右侧翻页」。
- **排序**：默认「最新在前」；点表头可切换升降序，切换列时文本类默认升序、ID / 时间类默认降序。**严重程度**（低<中<高<紧急）与**状态**（待处理<处理中<已解决<已关闭）按业务语义排序，而不是按中文字面顺序；排序会一并作用于导出。
- **列自定义**：标题 / 状态 / 操作三列固定，其余（ID、科室、提出人、类型、严重程度、附件、登记时间）可自由隐藏，配置存入浏览器 `localStorage`（键 `issue_tracker_columns`），一键「恢复默认」。
- **详情抽屉**：点击任意一行从右侧滑出抽屉，集中展示状态标签、科室 / 提出人 / 登记人 / 联系方式 / 处理人 / 软件系统 / 三个时间点、问题描述、处理说明与附件下载；底部可直接「编辑 / 删除」。
- **批量操作**：每行前置复选框 + 表头全选（本页），勾选后顶部出现操作条，可**批量改状态**（登记员也可用）或**批量删除**（仅管理员，同时清理附件文件）。单次上限 200 条，列表刷新后自动清空勾选，避免误操作不可见记录。
- **分页大小**：可选每页 10 / 20 / 50 条，选择写入 `localStorage`（键 `issue_tracker_pageSize`），切换时自动回到第 1 页。
- **导出说明**：导出文件会带上**当前筛选与排序条件**，避免文件离开系统后丢失上下文。CSV 写在首行；XLSX 写在第 1 行（第 2 行留空、第 3 行表头、第 4 行起数据），并冻结前 3 行便于滚动查看。
- **宽表滚动**：表格外层为 `.table-wrap`（`overflow-x:auto`），列表表格最小宽度 940px，窗口变窄时**容器内横向滚动**而不是把列挤压变形。
- **主题切换**：侧栏右上角图标可一键切换 **深色（默认）/ 浅色** 两套配色，选择写入浏览器 `localStorage`（键 `issue_tracker_theme`），下次打开自动沿用；切换同时作用于侧栏与登录页。实现方式是在 `<html>` 上打 `data-theme` 标记，配色差异全部由 CSS 覆盖，不涉及打包或重启。

**角色**：用户 `role` 分 `admin`（管理员）与 `reporter`（登记员）。
- 管理员：全部操作，含删除问题 / 附件、用户管理（新建 / 重置密码 / 停用启用）、查看操作日志。
- 登记员：可登记 / 编辑问题、上传附件；**不可删除**问题与附件，不可进入用户管理与审计。
- 由管理员在「用户管理」中创建新账号并指定角色；用户可在侧栏「修改密码」自助改密。

**附件**：在问题编辑弹窗内上传（单文件 ≤ 20MB），文件存于 `backend/uploads/`（可用 `UPLOADS_DIR` 修改），元数据记录在问题上；支持下载与（管理员）删除。**删除问题时会一并清理其磁盘附件文件**，避免留下孤儿文件。

**排序字段**：`sort` 取值 `id` / `title` / `department` / `reporter` / `type` / `severity` / `status` / `created_at` / `updated_at` / `resolved_at`，`order` 取 `asc` / `desc`。非法取值会被静默回落到默认（`created_at desc`），不做拼接、无注入风险。

**审计**：登录、新建 / 修改 / 删除问题、上传 / 删除附件、创建 / 停用用户、改密码、改系统设置等均写入审计日志（dev 为 `backend/data/audit.json`，生产为 `audit_log` 表）；管理员在「操作日志」页可按操作类型 / 操作人 / 起止日期筛选、分页查看，并导出 Excel / CSV。

**系统设置（左上角名称可配置）**：系统名称由后端统一提供，前端启动时读取并用于**登录页标题、侧栏品牌、浏览器标签页标题**。
- 默认值来自环境变量 `APP_NAME`（默认 `医院信息科 · 软件问题登记`）；管理员在「系统设置」页修改后写入存储（dev 为 `backend/data/settings.json`，生产为 `app_setting` 表），**保存即生效，无需重启或重新打包**。
- `GET /api/config` 对未登录用户开放（登录页也要显示名称），`PUT /api/settings` 仅管理员可调用，且写入审计。

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/problems/:id/attachments` | 上传附件（multipart，字段名 `file`） |
| GET | `/api/problems/:id/attachments/:fileId` | 下载附件 |
| DELETE | `/api/problems/:id/attachments/:fileId` | 删除附件（管理员） |
| GET | `/api/users` | 用户列表（管理员） |
| POST | `/api/users` | 创建用户（管理员） |
| PUT | `/api/users/:id/password` | 重置某用户密码（管理员） |
| PUT | `/api/users/:id/status` | 停用 / 启用账号（管理员，不可停用自己） |
| PUT | `/api/auth/password` | 修改本人密码 |
| GET | `/api/audit` | 审计日志（管理员，支持 `action` / `username` / `from` / `to` / 分页） |
| GET | `/api/audit/export?format=xlsx\|csv&...` | 导出审计日志（管理员，支持同款筛选） |

> 注：`DELETE /api/problems/:id` 同样限定管理员。

---

## 测试

后端自带端到端测试（dev 模式自动起服务，覆盖 **鉴权 / 角色权限 / 附件 / 排序 / 批量操作 / 导出格式 / 审计 / 系统设置** + 增删改查 / 筛选 / 统计，共 85 项断言）：

```bash
cd backend
npm test
```

---

## 下一步可扩展

- 科室字典对接 HIS
- 问题回访 / 满意度
- 附件类型 / 大小策略与安全扫描
- 登录失败锁定与更细的权限位
