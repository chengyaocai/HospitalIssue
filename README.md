# HospitalIssue — 团队协作说明

院方问题登记、实施协调相关项目。

## 团队协作工作流（AI 全流程托管）

```
AI 写代码 → git add/commit（自动规范提交信息）
   → git pull --rebase 同步远端（无冲突自动合并；有冲突给出建议 + 人工确认）
   → push 到 feature 分支 → 建 PR → 评审 → squash 合入 main
```

## 本地开发环境准备

```bash
# 首次克隆
git clone https://github.com/chengyaocai/HospitalIssue.git
cd HospitalIssue

# 日常开发（AI 可自动执行）
git switch -c feature/xxx      # 建功能分支
# ...编码...
git add . && git commit -m "feat: xxx"
git pull --rebase origin main  # 同步 + 合并
git push -u origin feature/xxx
```

> 本机直连 GitHub 间歇性受限，失败时重试即可；也可通过 WorkBuddy GitHub 连接器操作仓库。

## 角色分工

| 角色 | 职责 |
|---|---|
| AI 助手 | 编码、提交、拉取合并、发起 PR、回归自测 |
| 开发成员 | 本地开发、评审他人 PR |
| 管理员（chengyaocai） | 合并 main、分支保护规则、成员权限 |

## 邀请团队成员

仓库 → Settings → Collaborators → Add people → 输入对方 GitHub 用户名。
对方接受邀请后即可克隆、建分支、提交 PR。
