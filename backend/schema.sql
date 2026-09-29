-- 医院信息科软件问题登记 —— SQL Server 建表脚本
-- 执行前请先创建数据库（如 HospitalIssue）并切换上下文：USE HospitalIssue;
-- 后端在 DB_DRIVER=mssql 启动时也会按需自动建表（若不存在）。

-- 1) 软件问题表
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'software_issue')
BEGIN
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
        attachments NVARCHAR(MAX),           -- 附件元数据（JSON 数组字符串）
        registrar   NVARCHAR(100),           -- 登记人（表单可下拉选择，默认当前登录账号人员名）
        softwareSystem NVARCHAR(100),        -- 软件系统（来自系统设置可配置下拉项）
        createdBy   NVARCHAR(100),           -- 登记人登录账号（服务端注入，用于回访权限判定）
        satisfaction NVARCHAR(20),           -- 回访满意度：满意 / 一般 / 不满意（空=未回访）
        feedback    NVARCHAR(MAX),           -- 回访备注
        rated_at    DATETIME,               -- 回访打分时间
        audit_status NVARCHAR(20) NOT NULL DEFAULT N'待审核',  -- 审核状态：待审核 / 已通过 / 不通过
        audit_reason NVARCHAR(MAX),          -- 审核意见（不通过时必填）
        audit_by    NVARCHAR(100),           -- 审核人（姓名，缺省取登录账号）
        audit_at    DATETIME,                -- 审核时间
        created_at  DATETIME NOT NULL DEFAULT GETDATE(),
        updated_at  DATETIME NOT NULL DEFAULT GETDATE(),
        resolved_at DATETIME,
        deleted_at  DATETIME               -- 回收站（v1.6 软删除）：NULL=正常，非空=已入回收站
    );

    CREATE INDEX ix_software_issue_status ON dbo.software_issue(status);
    CREATE INDEX ix_software_issue_type   ON dbo.software_issue(type);
    CREATE INDEX ix_software_issue_dept   ON dbo.software_issue(department);
END
GO

-- 2) 用户表（登录鉴权）
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_user')
BEGIN
    CREATE TABLE dbo.app_user (
        id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        username    NVARCHAR(50) NOT NULL UNIQUE,
        name        NVARCHAR(100),
        role        NVARCHAR(30) NOT NULL DEFAULT N'reporter',  -- 内置角色 key（admin/reporter）或自定义角色 key
        active      BIT NOT NULL DEFAULT 1,                     -- 停用后不可登录
        is_platform_admin BIT NOT NULL DEFAULT 0,               -- 平台管理员（v1.18）：可跨机构管理
        user_type   NVARCHAR(16) NOT NULL DEFAULT N'hospital',  -- 用户类型（v1.18.12）：'hospital'=院方 / 'company'=公司（可归属多机构）
        phone       NVARCHAR(20),                               -- 联系电话（v1.18.17）：账号级，选填；值班表 / 处理人联系自动带出
        last_login_at DATETIME NULL,                            -- 最近登录时间（v1.18.44）：登录成功时更新；NULL=从未登录。用户管理列表展示
        password    NVARCHAR(200) NOT NULL,                     -- scrypt: salt:hash
        created_at  DATETIME NOT NULL DEFAULT GETDATE()
    );
END
GO

-- 3) 操作审计日志表
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'audit_log')
BEGIN
    CREATE TABLE dbo.audit_log (
        id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        username    NVARCHAR(50),
        action      NVARCHAR(50),
        target      NVARCHAR(100),
        detail      NVARCHAR(MAX),
        created_at  DATETIME NOT NULL DEFAULT GETDATE()
    );

    CREATE INDEX ix_audit_log_time ON dbo.audit_log(created_at);
END
GO

-- 4) 系统设置表（键值，如 appName）
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_setting')
BEGIN
    CREATE TABLE dbo.app_setting (
        [key]   NVARCHAR(50) NOT NULL PRIMARY KEY,
        [value] NVARCHAR(MAX)
    );
END
GO

-- 5) 消息通知表（一人一条：全员广播会为每个接收人各写一行）
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_notification')
BEGIN
    CREATE TABLE dbo.app_notification (
        id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        title       NVARCHAR(200) NOT NULL,
        body        NVARCHAR(MAX),
        from_user   NVARCHAR(50),
        to_user     NVARCHAR(50),
        broadcast   BIT NOT NULL DEFAULT 0,
        is_read     BIT NOT NULL DEFAULT 0,
        created_at  DATETIME NOT NULL DEFAULT GETDATE()
    );

    CREATE INDEX ix_app_notification_to ON dbo.app_notification(to_user, is_read);
END
GO

-- 5.1) 按用户隔离的工时配置（v1.18.43：每个公司用户自己的 WXP 账号/填报默认值/医院绑定；
--       mssql 模式启动时也会自动建表，此处供全新建库参考）
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_user_ts_config')
BEGIN
    CREATE TABLE dbo.app_user_ts_config (
        user_id     BIGINT NOT NULL PRIMARY KEY,
        username    NVARCHAR(50) NOT NULL,
        config_json NVARCHAR(MAX) NOT NULL,
        updated_at  DATETIME NOT NULL DEFAULT GETDATE()
    );
END
GO

-- 6) 值班表（v1.1 新增：按日期给处理人排班；mssql 模式启动时也会自动建表，无需手工执行）
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'duty_schedule')
BEGIN
    CREATE TABLE dbo.duty_schedule (
        id               BIGINT IDENTITY(1,1) PRIMARY KEY,
        duty_date        DATE NOT NULL,
        handler_username NVARCHAR(50),
        handler_name     NVARCHAR(100) NOT NULL,
        note             NVARCHAR(200),
        created_by       NVARCHAR(50),
        created_at       DATETIME NOT NULL DEFAULT GETDATE(),
        synced           INT NOT NULL DEFAULT 0
    );

    CREATE INDEX ix_duty_schedule_date ON dbo.duty_schedule(duty_date);
END
GO

-- 8) 聊天会话表与消息表（v1.16 新增：AI 助手 + 同事会话；mssql 模式启动时也会自动建表，无需手工执行）
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_chat_conversation')
BEGIN
    CREATE TABLE dbo.app_chat_conversation (
        id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        type        NVARCHAR(10) NOT NULL,       -- 'ai' | 'user'
        title       NVARCHAR(200),
        members     NVARCHAR(MAX),               -- 成员用户名数组（JSON 字符串）
        created_by  NVARCHAR(50),               -- 会话发起者（AI 会话唯一归属）
        created_at  DATETIME NOT NULL DEFAULT GETDATE(),
        updated_at  DATETIME NOT NULL DEFAULT GETDATE()
    );

    CREATE INDEX ix_app_chat_conversation_upd ON dbo.app_chat_conversation(updated_at);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_chat_message')
BEGIN
    CREATE TABLE dbo.app_chat_message (
        id               BIGINT IDENTITY(1,1) PRIMARY KEY,
        conversation_id  BIGINT NOT NULL,
        sender           NVARCHAR(50),
        body             NVARCHAR(MAX),
        read_by          NVARCHAR(MAX),          -- 已读用户名数组（JSON 字符串）
        attachments      NVARCHAR(MAX),          -- 附件元数据数组（JSON 字符串）
        recalled         INT NOT NULL DEFAULT 0, -- 撤回标记（v1.18.14）：0=正常，1=已撤回
        ref_json         NVARCHAR(MAX),          -- 问题引用元数据（v1.18.22）：JSON 字符串，存 {id,title,status} 快照，可空
        created_at       DATETIME NOT NULL DEFAULT GETDATE()
    );

    CREATE INDEX ix_app_chat_message_conv ON dbo.app_chat_message(conversation_id, created_at);
END
GO

-- 8.1) 聊天消息附件列增量迁移（v1.17 新增：仅老库需要，新库建表已包含；
--      应用启动时 mssqlChatStore 也会自动执行同样的迁移，无需手工执行）
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_chat_message') AND name = N'attachments')
    ALTER TABLE dbo.app_chat_message ADD attachments NVARCHAR(MAX);
GO

-- 8.2) 聊天消息撤回列增量迁移（v1.18.14 新增：仅老库需要，新库建表已包含；
--      应用启动时 mssqlChatStore 也会自动执行同样的平滑加列，无需手工执行）
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_chat_message') AND name = N'recalled')
    ALTER TABLE dbo.app_chat_message ADD recalled INT NOT NULL DEFAULT 0 WITH VALUES;
GO

-- 8.3) 聊天消息问题引用列增量迁移（v1.18.22 新增：仅老库需要，新库建表已包含；
--      应用启动时 mssqlChatStore 也会自动执行同样的平滑加列，无需手工执行）
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_chat_message') AND name = N'ref_json')
    ALTER TABLE dbo.app_chat_message ADD ref_json NVARCHAR(MAX) NULL;
GO

-- 7) 软件问题表增量迁移（v1.2 新增审核 4 列：仅老库需要，新库建表已包含；
--    应用启动时 mssqlRepo 也会自动执行同样的增量迁移，无需手工执行）
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'audit_status')
    ALTER TABLE dbo.software_issue ADD audit_status NVARCHAR(20) NOT NULL DEFAULT N'待审核' WITH VALUES;
GO
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'audit_reason')
    ALTER TABLE dbo.software_issue ADD audit_reason NVARCHAR(MAX);
GO
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'audit_by')
    ALTER TABLE dbo.software_issue ADD audit_by NVARCHAR(100);
GO
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'audit_at')
    ALTER TABLE dbo.software_issue ADD audit_at DATETIME;
GO

-- ============================================================
-- 9) 多机构模式（v1.18）
--    形态：单实例 + 单库 + 行级 org_id 隔离；全局账号 + 机构成员关系表。
--    应用启动时各 store 也会自动建表/加列，正常升级无需手工执行。
-- ============================================================

-- 9.1) 机构表
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_org')
BEGIN
    CREATE TABLE dbo.app_org (
        id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        code        NVARCHAR(50)  NOT NULL UNIQUE,   -- 机构编码（唯一，用于配置/对接）
        name        NVARCHAR(100) NOT NULL,          -- 机构名称（界面展示）
        active      BIT NOT NULL DEFAULT 1,          -- 停用后其成员不可再切进去
        created_at  DATETIME NOT NULL DEFAULT GETDATE()
    );
END
GO

-- 9.2) 用户-机构成员关系表（一个用户可归属多个机构，各机构内可有不同角色）
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_user_org')
BEGIN
    CREATE TABLE dbo.app_user_org (
        id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        user_id     BIGINT NOT NULL,
        org_id      BIGINT NOT NULL,
        role        NVARCHAR(30) NOT NULL DEFAULT N'reporter',
        created_at  DATETIME NOT NULL DEFAULT GETDATE()
    );
    CREATE UNIQUE INDEX ux_app_user_org ON dbo.app_user_org(user_id, org_id);
END
GO

-- 9.3) 机构级系统设置（每个机构一套 appName / handlers / softwareSystems / roles / permissions）
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_org_setting')
BEGIN
    CREATE TABLE dbo.app_org_setting (
        org_id  BIGINT NOT NULL,
        [key]   NVARCHAR(50) NOT NULL,
        [value] NVARCHAR(MAX),
        CONSTRAINT pk_app_org_setting PRIMARY KEY (org_id, [key])
    );
END
GO

-- 9.4) 用户表增量列：平台管理员标记（仅老库需要）
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'is_platform_admin')
    ALTER TABLE dbo.app_user ADD is_platform_admin BIT NOT NULL DEFAULT 0 WITH VALUES;
GO
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'active')
    ALTER TABLE dbo.app_user ADD active BIT NOT NULL DEFAULT 1;
GO

-- 9.7) 用户表增量列：用户类型（v1.18.12；仅老库需要，新库建表已包含）
--      'hospital'=院方用户（单机构）/ 'company'=公司用户（可归属多机构，仅平台管理员可创建与调整）。
--      存量账号全部自动归为院方；应用启动时 mssql 用户仓库也会自动执行同样的平滑加列，无需手工执行。
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'user_type')
    ALTER TABLE dbo.app_user ADD user_type NVARCHAR(16) NOT NULL DEFAULT N'hospital' WITH VALUES;
GO

-- 9.8) 用户表增量列：联系电话（v1.18.17；仅老库需要，新库建表已包含）
--      账号级字段、可空；用于值班表 / 处理人候选联系方式的自动带出。
--      应用启动时 mssql 用户仓库也会自动执行同样的平滑加列，无需手工执行。
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'phone')
    ALTER TABLE dbo.app_user ADD phone NVARCHAR(20);
GO

-- 9.9) 用户表增量列：最近登录时间（v1.18.44；仅老库需要，新库建表已包含）
--      登录成功时由后端更新（GETDATE()）；NULL=升级后尚未登录过。用户管理「最近登录」列展示。
--      应用启动时 mssql 用户仓库也会自动执行同样的平滑加列，无需手工执行。
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_user') AND name = N'last_login_at')
    ALTER TABLE dbo.app_user ADD last_login_at DATETIME NULL;
GO

-- 9.5) 业务表增量列：org_id（数据归属机构）
--      默认值 1 = 首次启动自动创建的「默认机构」；存量数据与未显式指定机构的新数据均归属默认机构。
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.software_issue') AND name = N'org_id')
    ALTER TABLE dbo.software_issue ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;
GO
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.audit_log') AND name = N'org_id')
    ALTER TABLE dbo.audit_log ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;
GO
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_notification') AND name = N'org_id')
    ALTER TABLE dbo.app_notification ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;
GO
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.duty_schedule') AND name = N'org_id')
    ALTER TABLE dbo.duty_schedule ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;
GO
-- duty_schedule.synced（v1.18.18）：跨机构同步来源标记。0=手工/复制周（永不被镜像同步删除），
-- 1=上次同步产生。WITH VALUES 0：存量条目（含 v1.18.13 时代同步产生的）全部自动视为手工、不受影响。
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.duty_schedule') AND name = N'synced')
    ALTER TABLE dbo.duty_schedule ADD synced INT NOT NULL DEFAULT 0 WITH VALUES;
GO
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_chat_conversation') AND name = N'org_id')
    ALTER TABLE dbo.app_chat_conversation ADD org_id BIGINT NOT NULL DEFAULT 1 WITH VALUES;
GO

-- 9.6) 平台管理员引导
--      全新库：首个用户（ensureSeed 创建的内置管理员）由应用侧直接写为平台管理员，无需此语句。
--      老库升级：应用启动时由 orgs/ensureOrgs 执行一次性引导 ——
--      若系统内尚无任何平台管理员，则把最早的一个 admin 角色用户提升为平台管理员，
--      避免升级后「无人能管理多机构」。此处不再重复 UPDATE，以免把普通管理员一并提升。
