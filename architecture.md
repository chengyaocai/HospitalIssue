# 架构设计｜医院信息科软件问题登记程序

> 由 software-company 团队主理人基于 PRD 整理：实现方案、文件清单、任务分解、数据结构与接口、SQL Server 表结构、dev 模式抽象。

## 1. 实现方案与框架选型
- **前端**：Vue 3 + Vite（SPA）。构建后由后端同源托管，避免跨域。
- **后端**：Node.js + Express，提供 REST API 与静态资源托管。
- **生产存储**：SQL Server，使用 `mssql`（底层 `tedious`，纯 JS 驱动），连接信息经 `.env` 配置。
- **dev / 测试存储**：本地 JSON 文件仓库（`devRepo`），无需数据库即可跑通与验证；通过环境变量 `DB_DRIVER=dev|mssql` 切换，默认 `mssql`（尊重用户生产选型）。
- **导出**：`exceljs` 生成 `.xlsx`，CSV 手写序列化。
- **校验**：后端统一字段校验，前端做必填与基础格式校验。

## 2. 文件清单
```
信息科登记问题程序/
├─ prd.md
├─ architecture.md
├─ README.md
├─ backend/
│  ├─ package.json
│  ├─ .env.example
│  ├─ schema.sql                # SQL Server 建表 DDL
│  ├─ src/
│  │  ├─ index.js               # Express 入口：API + 静态托管
│  │  ├─ config.js              # 读取 .env
│  │  ├─ validators.js          # 字段校验
│  │  ├─ db/
│  │  │  ├─ index.js            # 仓库工厂（按 DB_DRIVER 选择）
│  │  │  ├─ mssqlRepo.js        # SQL Server 实现
│  │  │  └─ devRepo.js          # 本地 JSON 文件实现
│  │  ├─ routes/problems.js     # CRUD / 筛选 / 统计 / 导出 路由
│  │  └─ services/export.js     # xlsx + csv
│  └─ test/api.test.mjs         # 端到端 fetch 测试
└─ frontend/
   ├─ package.json
   ├─ vite.config.js
   ├─ index.html
   └─ src/
      ├─ main.js
      ├─ App.vue
      ├─ api.js
      ├─ styles.css
      └─ components/
         ├─ FilterBar.vue
         ├─ StatsBar.vue
         ├─ ProblemForm.vue
         ├─ ProblemList.vue
         └─ ExportButtons.vue
```

## 3. 数据结构（问题记录）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT IDENTITY (dev: 自增/uuid) | 主键 |
| title | NVARCHAR(255) | 问题标题 * |
| department | NVARCHAR(100) | 所属科室 * |
| reporter | NVARCHAR(100) | 报修人 * |
| contact | NVARCHAR(100) | 联系方式 |
| type | NVARCHAR(20) | 故障/需求/咨询/其他 * |
| severity | NVARCHAR(20) | 低/中/高/紧急 * |
| status | NVARCHAR(20) | 待处理/处理中/已解决/已关闭 |
| description | NVARCHAR(MAX) | 问题描述 * |
| handler | NVARCHAR(100) | 处理人 |
| resolution | NVARCHAR(MAX) | 处理说明 |
| created_at | DATETIME | 登记时间 |
| updated_at | DATETIME | 更新时间 |
| resolved_at | DATETIME | 解决时间 |

### SQL Server 建表（schema.sql 摘要）
```sql
CREATE TABLE dbo.software_issue (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  title       NVARCHAR(255) NOT NULL,
  department  NVARCHAR(100) NOT NULL,
  reporter    NVARCHAR(100) NOT NULL,
  contact     NVARCHAR(100),
  type        NVARCHAR(20)  NOT NULL,
  severity    NVARCHAR(20)  NOT NULL,
  status      NVARCHAR(20)  NOT NULL DEFAULT N'待处理',
  description NVARCHAR(MAX) NOT NULL,
  handler     NVARCHAR(100),
  resolution  NVARCHAR(MAX),
  created_at  DATETIME NOT NULL DEFAULT GETDATE(),
  updated_at  DATETIME NOT NULL DEFAULT GETDATE(),
  resolved_at DATETIME
);
CREATE INDEX ix_software_issue_status ON dbo.software_issue(status);
CREATE INDEX ix_software_issue_type   ON dbo.software_issue(type);
```

## 4. REST API 约定
| Method | Path | 说明 |
|--------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/problems?status=&type=&department=&keyword=&page=&pageSize= | 列表（分页+筛选） |
| GET | /api/problems/stats | 统计（按状态/类型/科室计数） |
| GET | /api/problems/:id | 详情 |
| POST | /api/problems | 新增 |
| PUT | /api/problems/:id | 更新 |
| DELETE | /api/problems/:id | 删除 |
| GET | /api/problems/export?format=xlsx\|csv&status=&type=&department=&keyword= | 导出 |

请求体（新增/更新）字段：title, department, reporter, contact, type, severity, status, description, handler, resolution。

## 5. 程序调用流程（时序）
1. 浏览器加载 Vue SPA（由 Express 静态托管）。
2. 前端调用 `GET /api/problems` 拉取列表与 `GET /api/problems/stats` 拉统计。
3. 用户在 FilterBar 筛选 → 前端带参调列表接口。
4. 用户点「登记问题」→ ProblemForm 提交 → `POST /api/problems` → 刷新列表/统计。
5. 用户编辑/删除 → 对应 PUT/DELETE → 刷新。
6. 用户点导出 → `GET /api/problems/export?format=xlsx` → 浏览器下载。

## 6. 任务分解（按实现顺序）
1. 初始化 backend/package.json 与依赖（express, cors, dotenv, mssql, exceljs）
2. config.js + validators.js
3. db/devRepo.js（JSON 文件仓库，含初始化与种子）
4. db/mssqlRepo.js（SQL Server 实现）
5. db/index.js（工厂）
6. services/export.js（xlsx + csv）
7. routes/problems.js
8. src/index.js（Express 入口 + 静态托管 + 生产读取 frontend/dist）
9. schema.sql + .env.example
10. frontend 脚手架（package.json, vite.config, index.html, main.js, styles.css）
11. frontend 组件（api.js, App.vue, FilterBar, StatsBar, ProblemForm, ProblemList, ExportButtons）
12. 安装依赖 + 构建 frontend
13. QA：dev 模式端到端测试
14. README

## 7. 共享约定
- 时间统一用 ISO 字符串在 JSON 中传递；devRepo 与 mssqlRepo 均返回同一形状的对象数组。
- 枚举值（type/severity/status）前后端共用常量，仓库层做合法性校验。
- 错误响应统一 `{ error: "消息" }`，HTTP 状态码 400/404/500。

## 8. 待明确事项
- 生产环境 SQL Server 连接串由用户通过 `.env` 提供；本仓库 dev 模式可零配置跑通。
- 科室字典在 `frontend/src/api.js` 或后端常量中配置，后续可接 HIS。
