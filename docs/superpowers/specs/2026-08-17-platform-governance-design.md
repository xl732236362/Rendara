# Loomic 平台治理与演进设计

## 1. 背景与目标

Loomic 已具备完整的 AI 创作产品雏形：Next.js 前端、Fastify API、DeepAgents/LangGraph Agent、PGMQ Worker、Supabase 数据库与 Storage，以及基于 Excalidraw 的无限画布。当前问题不是功能不足，而是功能增长速度已经超过工程、安全和运维体系的承载能力。

本设计用于统一处理 `docs/tech/engineering-issues-register.md` 中的 38 项问题。项目尚未上线，允许重建开发与测试数据库，也允许调整内部 API，因此采用干净目标架构，不为现有开发数据保留长期兼容层。

治理结果必须满足：

1. 不同用户和工作区的数据、事件、运行与文件不能互相访问。
2. Agent 执行代码不能读取服务容器、凭证或任意访问网络。
3. 生成、扣费、任务和画布修改在重试、取消和并发下保持一致。
4. 新增模型、Provider、任务类型或画布节点时，只扩展对应注册项和能力实现。
5. 每个阶段结束后系统均可运行、演示和测试，并原则上可独立回退；阶段 3 永久删除尚未上线的用户 Skill 数据属于已批准的前滚例外。
6. 发布必须经过自动质量、安全、数据库和容器门禁。

## 2. 实施原则

- 风险优先：安全和数据一致性先于模块美化。
- 能力纵切：每项治理交付完整可运行链路，不制造长期半迁移状态。
- 单一事实源：契约、模型目录、配置、状态机和错误码各自只有一个权威定义。
- 显式依赖：关键服务、registry 和基础设施实例由 composition root 创建并注入。
- 边界校验：所有网络、数据库 JSON、队列消息和外部制品在进入系统时运行时校验。
- 默认拒绝：权限、网络、skill capability 和状态转换无法确认时拒绝执行。
- 渐进迁移：不为了目录整齐一次性搬迁无关代码；迁移与实际治理能力同步进行。
- 测试先行：每项修复先建立能复现风险或契约要求的失败测试。

## 3. 目标架构

```text
Web / HTTP / WebSocket / Agent Tools / Worker
                    |
             Interface Adapters
                    |
             Application Use Cases
      +-------------+-------------+
      |             |             |
  Generation      Canvas       Billing/Auth
    Domain         Domain         Domain
      |             |             |
      +-------------+-------------+
                    |
              Repository Ports
                    |
 Supabase / PGMQ / Storage / Providers / Sandbox
```

### 3.1 包与模块职责

- `packages/contracts`：HTTP、WebSocket、任务、事件、错误和画布节点 schema。不得依赖 React、Fastify 或 Supabase。
- `packages/model-catalog`：模型能力、Provider、限制、套餐、价格和 fallback 排序的唯一事实源。
- `packages/canvas-domain`：节点 schema、版本迁移、构造器、布局、操作、revision 和 patch。不得依赖 DOM、React 或数据库。
- `apps/server/src/domain`：任务状态机、计费规则、授权规则和幂等语义。
- `apps/server/src/application`：提交生成、取消生成、修改画布和 Agent capability 等用例。
- `apps/server/src/infrastructure`：Supabase repositories、PGMQ、Storage、Provider、safe-fetch、sandbox 和事件总线。
- `apps/server/src/interfaces`：HTTP、WebSocket、Agent tools 和 Worker adapters。
- `apps/web/src/data`：统一 API client、schema parse、query key、缓存、重试和失效。
- `apps/web/src/features`：按 canvas、chat、billing、projects 等产品能力组织界面；内置 Skill 不提供用户管理 feature。

### 3.2 强制依赖规则

- Interface 可以依赖 Application 和 Contracts。
- Application 可以依赖 Domain、Contracts 和 repository port。
- Domain 只能依赖标准库和纯类型/schema。
- Infrastructure 实现 port，但 Domain/Application 不反向依赖 Infrastructure。
- HTTP、WebSocket、Agent 和 Worker 不直接访问 Supabase、PGMQ 或画布 JSON。
- 跨边界禁止裸 `Record<string, unknown>` 和未经解析的类型断言。

## 4. 分阶段治理

## 阶段 0：安全止血与质量基线

### 范围

- 暂时关闭 production `execute`、外部 skill 自动启用和任意 tarball URL 导入。
- 为 `canvas.resume`、`agent.run`、`agent.cancel` 建立对象级授权；所有权解析失败必须终止操作。
- 建立统一 safe-fetch：仅 HTTPS、精确域名规则、禁止私网/回环/link-local、重定向逐跳复验、超时、MIME 与流式字节上限。
- 对 archive 增加下载大小、entry 数、嵌套深度和解压后总大小限制。
- 为 HTTP、WebSocket、上传、生成、代理和导入增加 IP/user/workspace/cost 分层限流。
- 修复 Biome 扫描范围和换行基线，使 lint 可通过。
- 移除前端忽略类型错误；后端生成真正 JavaScript 构建产物。
- 建立 CI：冻结依赖安装、lint、typecheck、test、build、Supabase reset、Docker smoke test。

### 验收

- 已认证用户无法 resume/cancel 其他工作区资源。
- safe-fetch 拒绝私网、恶意重定向、错误 MIME 和超限响应。
- 所有质量命令在干净 checkout 中通过。
- Production 环境没有可触达的宿主 shell。

## 阶段 1：契约、配置与应用内核

### 范围

- 统一工作区 Zod 主版本。
- 整理 `packages/contracts`，统一请求、成功响应、错误响应、WS command/event 和 queue message。
- 建立统一 `AppError` 与 Fastify error handler，移除各路由重复错误映射。
- Web 通用 fetcher 对响应执行 schema parse，并统一认证、超时、取消和错误转换。
- 用 schema 定义所有环境变量、默认值、范围、敏感性和适用进程，启动时 fail fast。
- 由 schema 校验 `.env.example` 和部署配置完整性。
- 建立显式 ProviderRegistry、ExecutorRegistry 和 composition root，重复名称/model ID 启动失败。
- 提取 `SubmitGeneration`、`CancelGeneration`、`ApplyCanvasOperations`、`ImportSkill` 应用用例；其中 `ImportSkill` 是阶段 3 删除动态 Skill 前的临时安全边界，不属于最终架构。

### 验收

- HTTP、WebSocket 与 Agent 调用同一生成用例。
- 任何无效配置在启动阶段给出明确错误。
- 网络响应结构错误在 data layer 被捕获，而不是在组件内报错。
- 路由不再包含计费、任务或数据库编排。

## 阶段 2：数据库、任务状态机与一致性

### 数据模型

- 重建开发/测试数据库并整理 migration 历史基线。
- `background_jobs` 增加 idempotency key、lease owner、lease expiry 和受约束状态字段。
- 明确状态转换：`queued -> running -> succeeded`，以及受限的 canceled/failed/retry/dead-letter 分支。
- 画布增加 `revision`，写入必须携带 expected revision。
- 扣费、退款、Webhook event 和任务请求增加唯一幂等约束。
- 建立 outbox；业务事务提交后由 dispatcher 可靠发送 PGMQ，并记录投递状态。

### 原子操作

- 任务创建、积分预留和 outbox 写入在同一数据库事务中完成。
- Worker 通过 lease 原子领取任务；完成/失败只允许从合法前置状态转换。
- 取消操作设置取消状态与信号，Worker 在外部调用前后检查。
- 重复消费返回既有结果，不重复调用模型或扣费。
- 画布写入采用 revision CAS；冲突返回 409 和最新 revision，不允许 last-write-wins 静默覆盖。

### RLS 与索引

- 建立稳定的 workspace/canvas/session/run ownership helper。
- security-definer function 使用空 `search_path` 和完全限定对象名。
- grant 遵循最小权限，客户端不得执行 server-only RPC。
- 优化 RLS 中的 `auth.uid()` 调用。
- 自动检查外键索引、RLS predicate 索引及高频 `WHERE + ORDER BY` 复合索引。

### 验收

- 重复提交、重复消息和 Worker 崩溃恢复不会重复扣费或生成。
- 已取消任务不能变成 succeeded。
- 两个并发画布写入中，过期 revision 明确失败。
- 临时 Supabase 从零重建并通过跨租户正反权限测试。

## 阶段 3：Agent 隔离、内置 Skill 与画布能力边界

### Sandbox

- 使用一次性容器、microVM 或成熟远端 sandbox provider，不在 API/Worker 容器执行用户代码。
- 每次 run 使用独立身份和文件系统，非 root、只读根文件系统。
- 设置 CPU、内存、PID、磁盘、执行时间和输出上限。
- 阶段 3 Sandbox 完全禁止网络出站；未来确有需求时另行设计域名授权和代理，不在本阶段预留宽松入口。
- Sandbox 不接收 Supabase service role、Provider key 或应用内部网络权限。
- 输出只通过 Sandbox 文件 port 受限下载，服务端验证路径、大小、MIME/magic bytes 并生成文件名，再经资产应用端口持久化。
- 每次 run 创建独立 lease；有效策略与 lease 生命周期持久化，`finally` 清理和重启后的 orphan reconciler 均幂等执行。
- 内置 Skill 脚本从启动时验证的内存 catalog 上传到 Sandbox，不挂载 API 宿主目录；产物只通过 Sandbox 文件 port 下载。

### 内置 Skill 模型

- 永久移除用户创建、导入、下载、市场安装、工作区安装和启停 Skill 的产品能力及数据模型。
- Skill 只来自仓库 `skills/`，并且必须由仓库级 manifest 显式列入并声明所需 capability；目录发现、请求、数据库和用户文件不能授予加载资格。
- manifest 内容在启动时复制为内存只读 `/skills/` backend，并通过 DeepAgents 官方 `skills` 配置加载；Agent 不直接读取宿主 Skill 目录。
- 每个 run 只看到其 capability 快照满足全部前置条件的 Skill；Skill 声明只能缩小可见集合，不能反向授予 capability。
- 内置 Skill 随应用代码审查、测试和发布，不建设外部来源 hash、签名、审批、revision 或兼容迁移体系。
- 先发布只读取内置 manifest 的运行时，再以前滚 migration 删除动态 Skill 表和历史数据；不提供恢复路径。

### 画布与 Capability 边界

- 每个 Agent run 必须绑定已授权的当前 `canvasId`，服务端解析并冻结 user/workspace/canvas 上下文。
- Capability 只取服务端部署 allowlist、Provider/Sandbox 可用能力和画布/项目/工作区授权的交集。
- 客户端请求、prompt、模型输出和 Skill 内容均不能授予 capability。
- 未授权工具不注册；高风险应用用例在副作用前再次检查同一执行上下文，工具不能改写目标 canvas/workspace。
- DeepAgents 自动文件工具、`task`、backend 路由和所有 subagent 同样受 capability map 约束，不能成为应用工具之外的旁路。

### 验收

- 只有 manifest 明确列出的仓库内置 Skill 能进入 Agent，外部或用户内容没有导入和执行路径。
- Agent 只能操作当前已授权画布，未授权工具不可见且应用端口直接调用同样被拒绝。
- 同一用户打开多个画布时，浏览器 RPC 仍按绑定 `canvasId` 路由，不能仅按 userId 选择连接。
- Sandbox 销毁后无法再次读取 run 文件。

## 阶段 4：画布领域模型与节点扩展体系

### 节点协议

- 业务节点统一使用 `customData.kind` 与 `customData.schemaVersion`。
- 建立 discriminated union，例如 image、video、image-generator、video-generator。
- 每种节点提供 schema、默认值、迁移、创建器、序列化和 capability。
- Excalidraw 原生字段由 adapter 负责，业务代码不手工拼接完整元素。

### Node Registry

每个节点注册：

- schema 与 migration
- 创建器与默认尺寸
- label、icon、renderer/panel
- selection adapter
- Agent serializer
- 允许的 operation
- export/screenshot/file capability

### 保存模型

- 持久化 asset manifest 与 Excalidraw runtime BinaryFiles 分离。
- 新文件只上传一次；普通节点变化只提交节点 patch 和 asset reference。
- 保留必要 tombstone/version，由后台 compaction 按策略清理。
- 所有用户、Agent 和 Worker 修改统一调用 `ApplyCanvasOperations`。

### 验收

- 新增一个测试节点只需要注册 schema、adapter 和 renderer，不修改工具栏/图层/Agent 多处分支。
- 浏览器、Agent 和 Worker 并发修改不会覆盖彼此。
- 移动普通节点不会重新上传全部媒体文件。

## 阶段 5：实时通信与横向扩展

### 设计

- WebSocket command 使用统一 authorization middleware。
- 事件携带 workspaceId、canvasId、runId、sequence 和 schemaVersion。
- 使用 Redis Streams、NATS JetStream 或具备等价语义的共享事件层；最终选择以团队运维能力为准，默认优先托管 Redis Streams。
- API 实例只维护本地 socket，事件和 active run 状态存放在共享层。
- 客户端用持久 cursor 恢复事件；进程重启不丢失回放窗口。
- Pending RPC 带 user/connection ownership、deadline 和取消。
- 限制每用户连接数、消息大小、command rate 和未完成 RPC 数。

### 验收

- 两个 API 副本下，任一副本发出的事件能到达另一副本连接的客户端。
- API 重启后客户端可以从 cursor 恢复。
- 客户端无法伪造 connectionId 覆盖其他连接。

## 阶段 6：前端数据层与界面模块化

### 数据层

- 使用成熟 query library 管理服务端状态，统一 query key、缓存、取消、重试和 mutation invalidation。
- Auth token 不进入 query key 或日志。
- 所有 API 响应在 data layer 运行时解析。
- 列表统一 cursor pagination；聊天消息和大型列表使用虚拟化。

### 组件拆分

- `chat-sidebar` 拆为 session、message stream、composer、run controller 等 feature 单元。
- `canvas-tool-menu` 拆为工具选择、节点 registry renderer、overlay host 和 selection controller。
- `canvas-editor` 保留 Excalidraw adapter、save coordinator 和 screenshot adapter，不承载业务面板状态。
- `server-api.ts` 按 projects、canvas、chat、generation 等保留领域拆分，共用底层 fetcher；阶段 3 已删除 Skill API client。
- 只在迁移相关功能时拆分，禁止纯目录搬家式大提交。

### 体验验收

- 页面切换不会重复拉取同一资源或闪烁旧状态。
- 请求取消、重试和错误提示行为一致。
- 长聊天、项目和技能列表保持可用性能。
- Canvas 常用流程通过桌面和移动端 E2E。

## 阶段 7：可观测性、性能与发布验收

### 可观测性

- 统一结构化 logger，标准字段包括 requestId、userId、workspaceId、sessionId、runId、jobId、provider/model、durationMs、attempt 和 errorCode。
- 敏感字段默认禁止记录；prompt 和第三方响应只记录长度、hash 或经批准摘要。
- 接入 OpenTelemetry traces，串联 HTTP -> use case -> DB/outbox -> Worker -> Provider -> Storage。
- 指标覆盖 API 延迟/错误率、WS 连接、queue lag、最老消息、生成成功率、Provider 延迟、积分异常、sandbox 资源和画布冲突率。

### 健康与发布

- `/live` 只验证进程存活。
- `/ready` 用短超时验证数据库、必要 schema、队列和事件层。
- Worker 上报 heartbeat、容量和当前任务。
- Migration 发布前执行备份与恢复演练；无法回滚的变更提供 forward-fix runbook。
- 发布采用预发布环境 smoke/E2E，再逐步放量；关键指标恶化自动停止。

### 性能验收

- 使用代表性大画布、长聊天和批量项目 fixture。
- 对高频查询记录 `EXPLAIN (ANALYZE, BUFFERS)` 基线。
- 建立 API、队列和画布保存的明确延迟与资源预算。
- 运行负载测试验证限流、连接池和多副本事件链路。

## 5. 测试体系

### 单元测试

- 状态机、计价、节点 migration、canvas patch、权限判断、safe URL 规则。

### 契约测试

- HTTP/WS/queue schema、Provider contract、Executor contract、Node registry contract。

### 数据库集成测试

- RLS 正反权限、幂等 RPC、并发扣费、outbox、任务 lease、canvas revision 和 Webhook 重放。

### 安全集成测试

- SSRF、重定向、压缩炸弹、跨租户 WS、非清单 Skill 加载、跨画布工具调用、sandbox 文件/网络逃逸。

### 端到端测试

- 注册/登录、项目创建、画布编辑、图片/视频生成、取消/重试、聊天恢复、内置 Skill 加载和支付 Webhook fixture。

### 发布门禁

- lint、typecheck、unit、contract、integration、E2E、migration reset、Docker smoke 和依赖审计全部通过。

## 6. 问题归属

| 阶段 | 覆盖问题 |
| --- | --- |
| 0 | ENG-003、004、006、010、028、029、031 |
| 1 | ENG-007、008、009、012、013、014、017、019-026 |
| 2 | ENG-001、002、005、011、015、018、034、037 |
| 3 | ENG-027、030 |
| 4 | ENG-011-018 |
| 5 | ENG-028、032、033 |
| 6 | ENG-007、020、035、038 |
| 7 | ENG-005、008、010、034-037 |

同一问题可能跨多个阶段：前一阶段先关闭风险或建立边界，后一阶段完成目标形态。

## 7. 执行与变更管理

- 每个阶段使用独立实施计划和分支，不创建一个覆盖全部阶段的超大 PR。
- 每个任务先写失败测试，再实现最小完整能力。
- 每个提交只包含一个可解释的行为变化，禁止混入无关格式化。
- 阶段开始前记录基线，结束后更新工程问题台账状态和验证证据。
- 数据库重建只针对开发/测试环境；任何生产启用前重新制定正式数据迁移计划。
- 旧路径与新路径短暂并存时必须有 feature flag、到期删除任务和双写/对比策略；不允许无限期保留。

## 8. 决策记录

- 当前尚未上线，允许重建开发/测试数据库及调整内部 API。
- 采用分阶段治理，每个阶段保持项目可运行。
- 安全边界和一致性优先于功能扩展与代码美化。
- 不在 API 容器中运行不可信 shell。
- 用户和外部来源不能创建、导入、安装或配置 Skill；阶段 3 对相关开发数据和 schema 的删除采用前滚修复，不提供功能回退。
- 画布采用 revision + operation/patch，不继续依赖无条件整文档覆盖。
- Agent、HTTP、WebSocket 和 Worker 共享应用用例，不复制业务编排。
- 技术实现由工程负责人决策，产品验收以安全、数据正确、可扩展和可演示为准。
