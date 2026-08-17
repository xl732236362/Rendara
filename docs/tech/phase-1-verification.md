# Loomic 阶段 1 验收记录

## 验收结论

阶段 1“契约与应用核心”已达到验收条件：Loomic 跨包/跨进程契约统一在 Zod 4，HTTP 错误和环境配置具有单一可验证边界，Provider/Executor 注册表不再依赖全局可变状态，队列生成、画布操作和 Skill 导入已经由应用用例统一编排，Web 数据边界会校验运行时响应。这些边界由语法感知的工作区架构测试持续约束。

无缓存测试、类型检查、生产构建、数据库从零重建与权限测试、正式 Docker 镜像与 API/Worker 入口探针全部通过。阶段 2 的事务一致性/状态机/revision 工作未被提前并入本阶段。

## 基本信息

- 验收日期：2026-08-18
- 实现基线：`c00852a6183121e2b982b6b926fe2b0cf0ca5011`
- 验收前实现提交：`2904479e3c52eb5e412231e6f9b121a70ef2684a`
- 工作分支：`codex/phase-1-contracts-application-core`
- 实现提交数：49
- 宿主验收环境：Windows 11 / Node.js 24.14.0 / pnpm 10.26.2 / Docker Desktop 29.6.1 / Supabase CLI 2.114.0
- CI 与 Server Docker runtime：Node.js 22

## 结果清单

| 项目 | 结果 | 精确证据 |
| --- | --- | --- |
| 完整质量门禁 | 通过 | `pnpm ci:check` 返回 0，lint、typecheck、test、build 全部完成 |
| 无缓存包测试 | 通过 | Turbo `--force`，8/8 tasks，0 cached；395 项 package tests |
| 工作区/架构测试 | 通过 | 63/63，包括 37 个负向架构 fixture 与真实源码扫描 |
| 无缓存类型检查 | 通过 | Turbo `--force`，8/8 tasks，0 cached |
| 无缓存正式构建 | 通过 | Turbo `--force`，5/5 tasks，0 cached；Web 生成 15 个静态页 |
| Biome | 通过 | 386 个文件，0 errors，443 warnings；低于阶段 0 记录的约 465 |
| 数据库重建 | 通过 | Supabase CLI 2.114.0，全部 31 个 migration 从空库应用，`db reset --yes` 返回 0 |
| 数据库权限测试 | 通过 | 1 个 SQL 文件，14/14 tests，`Result: PASS` |
| Docker 正式镜像 | 通过 | `loomic-server:phase1`，image ID `sha256:ee4957fd9116be7ff9a7ccbe06766241b60ad5963c58a30e87a3dd9bf00c065d` |
| 容器应用加载 | 通过 | 容器内 import `dist/app.js` 输出 `app-load-ok` |
| Railway API/Worker 探针 | 通过 | override 精确指向 `dist/server.js`/`dist/worker.js`；镜像内文件可读且 `node --check` 通过 |
| diff 完整性 | 通过 | 验收前 `git diff --check` 返回 0，工作树干净 |

## 测试计数

| 范围 | 测试文件 | 测试数 | 结果 |
| --- | ---: | ---: | --- |
| Workspace / Node test | 1 | 63 | 63 通过 |
| `@loomic/config` | 1 | 29 | 29 通过 |
| `@loomic/shared` | 1 | 36 | 36 通过 |
| `@loomic/server` | 35 | 257 | 257 通过 |
| `@loomic/web` | 16 | 73 | 73 通过 |
| 合计 | 54 | 458 | 458 通过，0 失败/跳过 |

`@loomic/ui` 的 `test` 脚本执行 TypeScript 检查，不产生额外测试断言，因此不虚增上表数量。

## 验收命令

以下命令均在验收前实现提交上执行，除特别说明外返回码均为 0。

```text
pnpm test:workspace
pnpm exec turbo run test --force
pnpm ci:check
pnpm exec turbo run typecheck --force
pnpm exec turbo run build --force

supabase --version
supabase start
supabase db reset --yes
supabase test db
supabase stop --no-backup

docker build -f apps/server/Dockerfile -t loomic-server:phase1 .
docker run --rm --entrypoint node loomic-server:phase1 -e "import('./dist/app.js').then(() => console.log('app-load-ok'))"
docker run --rm --entrypoint sh loomic-server:phase1 -c "test -r dist/server.js && node --check dist/server.js && echo api-entrypoint-ok"
docker run --rm --entrypoint sh loomic-server:phase1 -c "test -r dist/worker.js && node --check dist/worker.js && echo worker-entrypoint-ok"

pnpm why zod -r
git diff --check
```

Windows 上 npm 安装的 Supabase wrapper 没有可用 binary，验收使用官方 GitHub release 的 Windows amd64 zip 在临时目录解压，并先确认版本为 `2.114.0`；临时产物未进入仓库。首次 `start` 因主工作区遗留的同项目 Supabase 容器占用 `54322` 而返回 1；核对 Docker label/workdir 后用同版本 CLI 执行 `stop --no-backup`，再次 `start` 及后续全部数据库验收均通过。本地密钥、URL 和 token 未写入本文档。

## Zod 依赖审计

- Loomic 所有 workspace 源码和运行时契约的直接消费者统一声明 catalog Zod 4，解析为 `4.3.6`。
- 相关 LangChain、OpenAI 和 MCP production dependency graph 也解析为 Zod `4.3.6`。
- Web 构建工具 `shadcn 4.1.0` 的隔离传递图仍包含 Zod `3.25.76`。`apps/web/src/app/globals.css` 使用它的 Tailwind CSS，因此它不是未使用依赖；但该 Zod 3 不进入 Loomic 跨包或运行时契约。
- 工作区测试会扫描真实 Zod import，禁止源码消费包缺失 catalog 声明或解析为主版本 3。验收矩阵中的“One Zod major”指 contract authority/consumers，不虚构为整个第三方工具 lockfile 只有一个 major。

## 架构验证

`tests/workspace.test.mjs` 使用 TypeScript AST 而不是纯文本匹配，会拒绝并给出可操作的文件/行号：

- 模块级 Provider/Executor registry 状态，包括 alias/namespace 绕行。
- 路由局部 Zod duck typing 和 `ZodError` 名称判断。
- Web API 帮助函数中直接 `fetch`、未校验 `.json()` 和 response cast。
- 已迁移适配器直接 job 编排、HTTP 直调 Skill importer、Agent 绕过应用边界的画布/媒体写入。

扫描允许与业务语义不冲突的读取路径、单元测试 fixture、函数局部 registry 组合以及不相关 Map。手工 `rg` 可见的 `fonts.ts`/外部 Provider 响应 cast 和 Agent 画布读取不在本阶段 Web fetcher/写入绕行规则的范围内，不冒充为“全仓库零 cast/零 Supabase 访问”。

## 保留风险与后续阶段

- ENG-001/002：任务创建、扣费、入队和取消/完成仍需阶段 2 的事务边界与状态机。
- ENG-011/017：画布应用写入边界已收敛，但 revision、并发冲突和事件发布尚未完成。
- ENG-012/013/014/023：版本化业务节点协议、共享画布模型、节点 registry 和单一 model catalog 仍是后续架构工作。
- ENG-025：已强制 Phase 1 关键边界，但完整跨层 import/循环依赖图尚未纳入门禁。
- ENG-006：Biome 门禁可用且 warning 从约 465 降至 443，历史 warning 仍需按模块清理。
- ENG-027/030：Agent 安全沙箱和 Skill 供应链的目标架构仍属于阶段 3。

## 验收矩阵

| 要求 | 验收证据 |
| --- | --- |
| Loomic 契约单一 Zod major | catalog/manifests/lockfile，`pnpm why zod -r`，63 项 workspace 测试；`shadcn` 隔离构建工具例外已审计 |
| 共享 HTTP/WS/队列契约 | Shared 36 项契约测试及路由/Worker 边界回归 |
| 统一错误 | Fastify 全局 handler 测试、真实路由测试和 AST 禁止局部 Zod 映射 |
| Fail-fast 配置 | Config 29 项、Server env 10 项、53 个 descriptor 的模板/部署校验 |
| 显式 registry | 重复/隔离/seal/不可变测试，组合根注入与 AST 门禁 |
| 共享应用用例 | HTTP/Agent/Worker spy 测试及 adapter bypass 架构规则 |
| Web 响应校验 | malformed/schema/timeout/abort/empty 测试，`server-api.ts` 无未校验 response cast |
| 生产可用性保持 | 无缓存质量门禁、DB reset/RLS、Docker/app-load/API/Worker 探针、diff 检查 |
