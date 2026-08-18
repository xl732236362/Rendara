# Loomic 阶段 0 验收记录

## 验收结论

阶段 0“安全止血与工程基线”已达到验收条件：默认危险入口已关闭，跨用户资源访问已阻断，外部下载和高成本入口已有边界，代码、数据库与正式容器均能通过自动化检查。

本阶段没有把所有长期架构问题一次性解决。Agent 真正隔离执行仍保留在阶段 3；外部 Skill 风险入口已临时关闭，阶段 3 将永久删除用户创建、导入、市场和安装能力，改为仓库清单内置 Skill。

## 基本信息

- 验收日期：2026-08-17
- 阶段 0 实现提交：`4a3e01e2e5ccda1b948b88045fe19ee36fb1af10`
- 干净环境修复提交：`7310445`（类型检查会先构建工作区依赖）
- 工作分支：`codex/phase-0-security-baseline`
- 验收范围：ENG-003、ENG-004、ENG-006、ENG-010、ENG-027、ENG-028、ENG-029、ENG-030、ENG-031

## 结果清单

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 正式质量检查 | 通过 | lint、类型检查、全部测试、Server/Web 正式构建均通过 |
| 自动化测试 | 通过 | Server 62、Web 52、Shared 27、Workspace 16，共 157 项 |
| 干净副本复验 | 通过 | 全新检出后使用锁定依赖安装，完整 `ci:check` 通过 |
| 数据库重建 | 通过 | 本地 Supabase 从空库依次应用全部 migration |
| 数据库权限测试 | 通过 | 14 项 RLS 与最小权限测试通过 |
| Web 生产构建 | 通过 | 15 个页面成功生成，构建不再忽略类型错误 |
| Server 生产构建 | 通过 | 生成 `dist/server.js` 与 `dist/worker.js` |
| Docker 正式镜像 | 通过 | `loomic-server:phase0` 构建成功 |
| 容器应用加载 | 通过 | 容器内加载 `dist/app.js` 输出 `app-load-ok` |
| diff 完整性 | 通过 | `git diff --check` 无空白错误；仅提示现有 CRLF 将统一为 LF |

## 安全回归覆盖

- 安全能力默认值与生产本地执行保护
- canvas、session、run 对象级授权
- HTTP 与 WebSocket 运行、恢复、取消授权及连接身份保护
- 真实数据库角色下的 canvas、session 跨工作区隔离
- HTTP 用户/IP 限流与 WebSocket 消息预算
- 图片代理认证与安全下载
- HTTPS、精确域名、DNS 私网、重定向、超时、MIME 和大小限制
- 外部 Skill 导入开关、默认禁用和压缩包资源预算

对应自动化测试组：`security capability defaults`、`production agent execution`、`resource authorization`、`HTTP run authorization`、`WebSocket run authorization`、`WebSocket resource commands`、`ConnectionManager identity`、`HTTP rate limiting`、`WsCommandBudget`、`safeFetch`、`image proxy`、`external skill import capability`、`SkillArchiveBudget`、`skill import route`，以及 `phase_0_security.test.sql`。

## 已知剩余项

- ENG-006：lint 已恢复为可靠门禁，但约 465 条历史 warning 尚未清零。推荐规则仍开启，后续按模块逐步治理，避免一次性大改影响业务。
- ENG-027：生产本地 Shell 默认关闭，但真正的一次性容器或远端沙箱尚未建设。
- ENG-030：外部 Skill 默认关闭、导入后默认禁用并要求审阅；阶段 3 不再建设签名和审批体系，而是永久删除外部及用户 Skill 能力与数据，只允许仓库清单内置 Skill。

## 验收命令

```text
pnpm ci:check
supabase db reset --yes
supabase test db
docker build -f apps/server/Dockerfile -t loomic-server:phase0 .
docker run --rm --entrypoint node loomic-server:phase0 -e "import('./dist/app.js').then(() => console.log('app-load-ok'))"
git diff --check
```

数据库本地密钥及其他敏感输出不写入本文档。
