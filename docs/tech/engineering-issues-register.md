# Loomic 工程问题台账

> 用途：持续收集架构、工程规范、可靠性、安全性和可维护性问题。当前阶段只记录和核实问题，不在发现过程中零散整改；待收集完成后统一评估、排序和实施。

## 维护规则

- 每个问题使用稳定编号 `ENG-NNN`，后续讨论、提交和测试均引用该编号。
- 新问题先标记为 `待确认`；补充代码证据和影响分析后改为 `已确认`。
- 严重度表示潜在影响，不等同于最终实施优先级。
- 在统一治理前，不把“建议方向”视为最终技术方案；实施前仍需完成设计评审。
- 问题关闭时必须补充关联提交、验证方式和关闭日期，不直接删除历史记录。

## 状态说明

| 状态 | 含义 |
| --- | --- |
| 待确认 | 已观察到信号，尚未完成证据核实 |
| 已确认 | 代码证据和影响明确，等待统一排期 |
| 方案中 | 正在设计或评审解决方案 |
| 处理中 | 已进入实施 |
| 部分解决 | 当前阶段已降低或关闭主要风险，但目标架构仍需后续阶段完成 |
| 已解决 | 已实施并通过验证 |
| 不处理 | 经评审接受风险，需记录原因 |

## 问题总览

| 编号 | 严重度 | 状态 | 领域 | 摘要 |
| --- | --- | --- | --- | --- |
| ENG-001 | P0 | 已确认 | 队列与数据一致性 | 创建任务与发送 PGMQ 消息缺少原子一致性边界 |
| ENG-002 | P0 | 已确认 | 任务状态机 | 取消任务可能被 Worker 后续覆盖为成功或失败 |
| ENG-003 | P1 | 已解决 | 构建与部署 | 后端构建只生成标记文件，生产环境直接运行 TypeScript 源码 |
| ENG-004 | P1 | 已解决 | 构建与部署 | 前端生产构建忽略 TypeScript 错误 |
| ENG-005 | P1 | 已确认 | 测试 | 后端关键业务链路缺少自动化测试 |
| ENG-006 | P1 | 部分解决 | 工程规范 | lint 基线不可用，无法作为质量门禁 |
| ENG-007 | P2 | 已确认 | 模块边界 | Agent、聊天和画布等核心文件职责过度集中 |
| ENG-008 | P2 | 已确认 | 可观测性 | 业务日志未统一接入结构化日志和链路上下文 |
| ENG-009 | P2 | 已确认 | Monorepo 边界 | `config` 与 `ui` 共享包尚未承担真实共享职责 |
| ENG-010 | P1 | 已解决 | 持续集成 | 仓库缺少 CI 工作流，质量检查未形成合并门禁 |
| ENG-011 | P0 | 已确认 | 画布一致性 | 浏览器、Worker 与 Agent 以整份 JSON 覆盖保存，存在静默丢失更新 |
| ENG-012 | P1 | 已确认 | 节点协议 | 业务节点依赖未版本化、弱类型的 `customData` 约定 |
| ENG-013 | P1 | 已确认 | 画布模型 | 前后端分别手工构造 Excalidraw 元素，规则已出现重复与漂移 |
| ENG-014 | P1 | 已确认 | 节点扩展性 | 节点识别、渲染和交互分散在多个组件，缺少统一注册机制 |
| ENG-015 | P2 | 已确认 | 演进能力 | 持久化时移除删除标记，不利于撤销、合并和实时协作扩展 |
| ENG-016 | P1 | 已确认 | 媒体持久化 | 已存储媒体在加载后回灌为 data URL，后续保存会重复上传 |
| ENG-017 | P1 | 已确认 | 模块边界 | Agent 和 Worker 绕过 CanvasService 直接读写画布 JSON |
| ENG-018 | P2 | 已确认 | 画布测试 | 画布服务、节点协议和并发保存缺少针对性测试 |
| ENG-019 | P1 | 已确认 | 应用层 | 同一生成与扣费流程在 HTTP、Agent 等入口重复编排 |
| ENG-020 | P1 | 已确认 | API 契约 | 请求和响应的运行时校验策略不一致 |
| ENG-021 | P2 | 已确认 | 错误处理 | 路由层重复实现鉴权、Zod 和领域错误映射 |
| ENG-022 | P1 | 已解决 | 配置管理 | 环境配置已由共享 schema、进程约束和部署模板校验统一管理 |
| ENG-023 | P1 | 已确认 | 模型目录 | 模型能力、价格、权限和默认值存在多个事实源 |
| ENG-024 | P2 | 已确认 | 扩展注册 | Provider 与 Executor registry 使用进程级可变全局状态 |
| ENG-025 | P2 | 已确认 | 架构治理 | 模块依赖方向和边界没有自动化约束 |
| ENG-026 | P2 | 已确认 | 依赖治理 | 工作区同时使用 Zod 3 与 Zod 4 处理跨包契约 |
| ENG-027 | P0 | 部分解决 | Agent 安全 | Production execute 并未隔离容器文件系统与网络 |
| ENG-028 | P0 | 已解决 | WebSocket 授权 | 画布事件订阅与运行取消缺少资源所有权校验 |
| ENG-029 | P0 | 已解决 | 外部请求安全 | 图片代理与 skill 导入存在 SSRF 和无界下载风险 |
| ENG-030 | P0 | 部分解决 | Skill 供应链 | 外部 skill 可影响具备 shell 权限的 Agent，缺少信任与审批边界 |
| ENG-031 | P1 | 已解决 | 滥用防护 | 高成本 HTTP、WebSocket、上传和代理接口缺少统一限流 |
| ENG-032 | P1 | 已确认 | 横向扩展 | WebSocket、事件回放和活跃运行状态仅保存在单进程内存中 |
| ENG-033 | P1 | 已确认 | 认证 | Token 缓存缺少硬容量上限和主动失效机制 |
| ENG-034 | P2 | 已确认 | 数据库性能 | 部分 RLS 策略仍使用逐行 `auth.uid()` 并缺少系统化索引验证 |
| ENG-035 | P2 | 已确认 | 数据访问 | 消息、项目、技能等列表接口缺少一致的分页策略 |
| ENG-036 | P1 | 已确认 | 可运维性 | 健康检查只返回常量，缺少 readiness 与关键依赖诊断 |
| ENG-037 | P2 | 已确认 | 数据库交付 | Migration 缺少自动化重建、静态安全检查和升级验证流程 |
| ENG-038 | P2 | 已确认 | 前端数据层 | 服务端状态主要由组件 useEffect 手工管理，缓存与失效规则分散 |

## 已确认问题

### ENG-001：创建任务与发送队列消息缺少原子一致性边界

- 严重度：P0
- 状态：已确认
- 证据：`apps/server/src/features/jobs/job-service.ts` 先插入 `background_jobs`，随后调用 `pgmq.send`；发送失败时再尝试删除任务记录。
- 影响：数据库与队列可能出现单边成功；客户端重试或消息重复投递可能造成重复生成、重复扣费或永久停留在 `queued` 的任务。
- 备注：README 中“PGMQ guarantees exactly-once delivery”的表述与实际可靠性模型不符，业务应按至少一次投递设计。
- 建议方向：评估 transactional outbox、数据库事务/RPC，以及贯穿创建、扣费、模型调用和结果落库的幂等键。

### ENG-002：任务取消与 Worker 完成存在状态竞争

- 严重度：P0
- 状态：已确认
- 证据：取消操作允许将 `queued` 或 `running` 任务更新为 `canceled`；Worker 的 `markSucceeded`、`markFailed` 等更新没有校验前置状态或受影响行数。
- 影响：用户已取消的任务仍可能继续调用模型并最终变成成功或失败，造成状态认知、资源消耗和计费不一致。
- 建议方向：定义显式任务状态机，以条件更新或数据库 RPC 实现原子状态转换，并引入 worker lease/version 和协作式取消检查。

### ENG-003：后端生产构建未生成可部署产物

- 严重度：P1
- 状态：已解决
- 证据：`apps/server/package.json` 的 `build` 调用 `scripts/validate-foundation-app.mjs`；该脚本只校验配置并写入 `dist/.loomic-build`。Docker 生产阶段通过 `tsx` 直接运行 `src/server.ts` 或 `src/worker.ts`。
- 影响：构建成功不能证明服务可加载运行；生产镜像包含开发运行时和源码，增加镜像体积、冷启动成本及供应链攻击面，部分错误会推迟到启动时暴露。
- 建议方向：建立真实编译产物，生产镜像只携带运行依赖、`dist` 和必要资源，并增加镜像启动 smoke test。
- 阶段 0 结果：后端已改为 TypeScript 正式编译，API 与 Worker 均从 `dist` 启动；生产镜像只安装生产依赖并使用非 root 用户。镜像构建及容器内应用加载验证均通过，关闭于 2026-08-17。

### ENG-004：前端生产构建忽略 TypeScript 错误

- 严重度：P1
- 状态：已解决
- 证据：`apps/web/next.config.ts` 配置 `typescript.ignoreBuildErrors: true`。
- 影响：部署平台可能在类型错误存在时继续发布；当前本地 typecheck 通过不能约束未来提交。
- 建议方向：移除忽略配置，并由 CI 强制执行独立 typecheck 和正式 build。
- 阶段 0 结果：已移除 `ignoreBuildErrors`，并将类型检查和 Next.js 正式构建纳入统一 CI 检查；15 个页面静态生成通过，关闭于 2026-08-17。

### ENG-005：后端关键业务链路缺少自动化测试

- 严重度：P1
- 状态：已确认
- 证据：本次审查时后端只有 1 个测试文件、3 个测试，主要覆盖 OpenAI 图片 provider；前端共有 15 个测试文件、51 个测试。
- 影响：认证与租户隔离、积分并发、队列重试/死信、Webhook 幂等、Agent 恢复、WebSocket 鉴权和 RLS 等高风险链路缺少回归保护。
- 建议方向：优先建设任务状态机、积分账本、Webhook、RLS 和队列恢复的数据库集成测试，再补 API 契约与端到端测试。

### ENG-006：lint 基线不可用

- 严重度：P1
- 状态：部分解决
- 证据：本次运行 `pnpm lint` 失败，Biome 报告约 14,902 个错误；包含 `.next.stale-*` 等生成目录、CRLF 格式差异、显式 `any` 和 import 排序问题。
- 影响：lint 无法作为提交门禁，也无法可靠识别新增问题；大量噪声会使真实缺陷被淹没。
- 建议方向：先修正扫描范围，统一 `.editorconfig`/`.gitattributes` 和格式基线，再分批清理真实诊断并在 CI 中禁止新增违规。
- 阶段 0 结果：已排除构建产物和报告目录，统一换行与格式基线，`pnpm lint` 已可稳定通过并进入 CI。当前仍保留约 465 条历史 warning，后续阶段应按模块逐批清零；推荐规则仍保持开启。

### ENG-007：核心模块职责过度集中

- 严重度：P2
- 状态：已确认
- 证据：本次统计中 `agent/runtime.ts` 约 1309 行、`chat-sidebar.tsx` 约 1096 行、`manipulate-canvas.ts` 约 829 行、`skill-import-service.ts` 约 814 行、`server-api.ts` 约 732 行。
- 影响：修改局部功能时需要理解多个业务域，增加冲突、回归和测试替身复杂度；核心编排逐步演变为隐式依赖中心。
- 建议方向：优先按应用用例和业务能力拆分，明确依赖注入与事件/契约边界，避免只按文件行数机械拆分。

### ENG-008：日志缺少统一结构和链路上下文

- 严重度：P2
- 状态：已确认
- 证据：Fastify 已启用 logger，但 Agent runtime、Worker、job service、provider 和 marketplace 等模块大量直接使用 `console.log/error/warn`。
- 影响：API、Agent、队列和 Worker 之间难以串联排查；字段、错误码、耗时和脱敏策略不一致，不利于告警与聚合分析。
- 建议方向：提供统一 logger/context，标准化 `requestId`、`runId`、`jobId`、`workspaceId`、provider/model、耗时、重试次数和错误码，并明确敏感数据脱敏规则。

### ENG-009：共享包边界与实际职责不一致

- 严重度：P2
- 状态：已确认
- 证据：`packages/ui/src/index.ts` 仅导出 `uiPackageStatus = "placeholder"`；`packages/config` 仅输出包名和说明，而 Web 和 Server 仍分别维护 UI 基础设施与配置逻辑。
- 影响：目录结构向开发者传递了并不存在的复用边界，增加包构建和认知成本，也容易造成未来重复实现。
- 建议方向：统一决定这些包的目标职责；要么迁入稳定、真实的共享能力，要么在边界成熟前移除空壳包。

### ENG-010：缺少持续集成质量门禁

- 严重度：P1
- 状态：已解决
- 证据：本次审查时仓库不存在 `.github/workflows`，部署配置也未体现等价的强制质量检查流程。
- 影响：测试、类型检查、lint 和构建依赖开发者本地主动执行；失败代码仍可能进入主分支或生产部署。
- 建议方向：建立最小 CI 流水线，固定 Node/pnpm 版本并执行 lockfile 安装、lint、typecheck、test、build；数据库迁移和 Docker 镜像增加独立验证阶段。
- 阶段 0 结果：已建立 quality、database、docker 三类流水线，固定包管理器版本并使用 frozen lockfile；代码质量、数据库从零重建和正式镜像构建均形成门禁，关闭于 2026-08-17。

### ENG-011：整画布覆盖保存会静默丢失并发更新

- 严重度：P0
- 状态：已确认
- 证据：浏览器 `canvas-editor.tsx` 的自动保存、`canvas-element-writer.ts` 的生成结果插入，以及 `manipulate-canvas.ts` 的 Agent 操作都会读取或持有一份完整 `content`，然后通过 `.update({ content })` 覆盖整份 JSON；表记录和请求中没有 revision、ETag 或 compare-and-swap 条件。
- 影响：用户拖动画布期间 Worker 插入图片、Agent 修改节点或另一页面保存时，最后到达的写入会静默覆盖其他写入。现有 1.5 秒 debounce 和卸载 flush 会进一步扩大竞态窗口。
- 建议方向：先明确单写者还是多写者模型；至少引入画布 revision 和条件更新/冲突返回。若要支持 Agent、Worker 和用户并发编辑，应评估操作日志、元素级 patch 或 CRDT，而不是继续整文档 last-write-wins。

### ENG-012：业务节点协议未版本化且缺少运行时校验

- 严重度：P1
- 状态：已确认
- 证据：图片生成器、视频生成器和视频节点通过 Excalidraw 原生 `rectangle`/`embeddable` 加 `customData.type` 或 `customData.isVideo` 表达；`canvasContentSchema` 仅校验 `Record<string, unknown>`，类型守卫只比较一个字符串或布尔值。
- 影响：缺字段、旧字段、非法状态或未来字段重命名都能进入数据库，通常直到具体面板渲染或 Agent 解析时才暴露。节点升级缺少迁移入口，也无法可靠判断画布内容版本。
- 建议方向：定义共享的、带 `kind` 和 `schemaVersion` 的 discriminated union，为每种业务节点提供 Zod schema、解析、默认值和迁移函数；持久化边界执行校验并保留兼容策略。

### ENG-013：前后端重复维护 Excalidraw 元素构造规则

- 严重度：P1
- 状态：已确认
- 证据：`apps/web/src/lib/canvas-elements.ts` 与 `apps/server/src/features/canvas/canvas-element-writer.ts` 分别实现元素 ID、默认字段、缩放、自动布局、图片和视频构造；服务端文件明确标注 placement 逻辑由前端移植。
- 影响：新增字段、升级 Excalidraw 或修复布局时需要同步多处。目前前端空画布以 viewport center 放置，服务端以原点为中心；媒体 metadata 和文件引用策略也不完全一致。
- 建议方向：把与 DOM 无关的 scene model、节点构造器、布局算法和 metadata schema 下沉到共享 canvas-domain 模块；浏览器适配层只处理 viewport、Blob 和 Excalidraw imperative API。

### ENG-014：缺少统一的业务节点注册与能力描述

- 严重度：P1
- 状态：已确认
- 证据：新增节点类型需要分别修改 generator helper、`canvas-tool-menu.tsx`、layers/files panel、overlay、`renderEmbeddable`、选择信息、`inspect_canvas` 和可能的 Agent manipulate handler。图片与视频生成器已有大量平行实现。
- 影响：增加音频、文档、3D、组合生成器等节点时改动面大且容易漏掉某个消费者；节点能力通过条件分支隐式表达，无法统一查询其是否可渲染、生成、导出、截图或供 Agent 操作。
- 建议方向：建立业务节点 registry/adapter，以 `kind` 注册 schema、创建器、renderer/panel、label/icon、selection adapter、Agent serializer 和可用操作；共享核心保持平台无关，React 渲染器按需加载。

### ENG-015：删除元素时丢弃 tombstone

- 严重度：P2
- 状态：已确认
- 证据：`canvas-editor.tsx` 在普通保存、规范化保存和卸载 flush 中均通过 `filter(!el.isDeleted)` 删除 tombstone；服务端读取到的只剩当前快照。
- 影响：当前单用户快照模式可以工作，但会丢失 Excalidraw 的删除版本信息，使跨页面合并、离线同步、撤销恢复和未来实时协作更难正确实现。
- 建议方向：在确定画布同步模型后决定 tombstone 生命周期；如果采用元素级合并，需要保留删除版本并由受控 compaction 清理，而不是每次客户端保存立即删除。

### ENG-016：媒体加载与保存形成重复下载上传链路

- 严重度：P1
- 状态：已确认
- 证据：服务端加载画布时把 `oss://` 文件引用转换成 public `storageUrl`；浏览器随后下载文件并转换成 data URL 加入 Excalidraw。自动保存从 `getFiles()` 重新取得 data URL，`extractFilesToStorage` 又执行 upsert 上传。
- 影响：拖动或编辑普通节点也可能触发大媒体文件重新编码和上传，增加内存、带宽、Storage 请求和保存延迟；大画布还会受到 unload keepalive 约 64 KiB 限制。
- 建议方向：把持久化文件引用与 Excalidraw 运行时 BinaryFiles 分离，维护稳定 asset manifest 和脏文件集合；只有新增或实际变化的二进制文件上传，画布保存只提交引用和节点 patch。

### ENG-017：画布写入绕过统一领域服务

- 严重度：P1
- 状态：已确认
- 证据：`CanvasService` 只提供整份读取和保存；Worker 的 `canvas-element-writer.ts` 与 Agent 的 `manipulate-canvas.ts` 均直接访问 `canvases.content`，各自实现读改写、错误处理和文件策略。
- 影响：权限、revision、校验、迁移、日志和冲突处理无法在一个边界统一实施；未来修改存储模型需要同时改动多个调用方。
- 建议方向：建立 canvas repository/application service，暴露 `applyOperations`、`insertArtifact` 等用例；所有写入统一经过校验、并发控制、审计日志和事件发布。
- 阶段 1 进展：已建立 transport-neutral `ApplyCanvasOperations`、显式授权/操作端口与复用 `CanvasService` 的适配器，并覆盖授权顺序、输入/输出运行时校验和脱敏日志。Agent/Worker 现有整份 JSON 直写尚未迁移，并发控制、revision 与事件发布仍属于后续阶段，因此本项仅为部分解决。

### ENG-018：画布领域缺少针对性测试

- 严重度：P2
- 状态：已确认
- 证据：现有前端测试覆盖部分元素转换、overlay 几何和生成 UI 状态，但未发现 CanvasService、`canvas-element-writer`、`inspect_canvas`、`manipulate_canvas`、节点 schema 迁移或并发冲突测试。
- 影响：节点协议漂移、文件引用丢失、整画布覆盖、绑定关系损坏和 Excalidraw 升级兼容问题缺少回归保护。
- 建议方向：补齐共享节点契约测试、scene 操作单元测试、持久化集成测试、并发保存测试和关键节点的交互测试；对每个 registry 节点运行统一 contract test suite。

### ENG-019：业务用例在多个入口重复编排

- 严重度：P1
- 状态：已确认
- 证据：图片/视频任务创建、套餐校验、积分扣减和任务 metadata 分别在 `http/jobs.ts`、`http/generate.ts` 与 `agent/runtime.ts` 中编排；同步与异步路径还维护各自的异常和退款逻辑。
- 影响：新增生成类型、调整计费顺序或修复补偿逻辑时需要修改多个入口，违反 DRY 和单一职责原则；不同入口容易出现价格、权限、状态和日志行为不一致。
- 建议方向：把“提交生成任务”“执行同步生成”“结算/补偿”建模为应用层 use case。HTTP、WebSocket 和 Agent tool 只负责协议适配与身份上下文，不直接组合多个领域服务。

### ENG-020：API 运行时契约执行不一致

- 严重度：P1
- 状态：已确认
- 证据：部分服务端路由使用共享 Zod schema 解析请求和响应，另一些路由通过 `request.body as ...` 直接断言；Web 客户端大多数响应通过 `(await response.json()) as ResponseType` 断言，没有执行共享 response schema。
- 影响：TypeScript 类型不会验证网络数据。后端部署版本不一致、字段缺失或错误响应结构变化时，问题会在 UI 深处以空值或运行时错误出现，契约漂移不能在边界被及时发现。
- 建议方向：统一请求、成功响应和错误响应的 schema；服务端在框架 schema/compiler 层执行，客户端由通用 fetcher 在边界 parse。对性能敏感接口可评估开发/测试强校验和生产轻量校验策略。

### ENG-021：路由层错误映射重复且不一致

- 严重度：P2
- 状态：已确认
- 证据：`canvases.ts`、`chat.ts`、`brand-kits.ts`、`jobs.ts` 等分别实现近似的 `sendUnauthorized`、`isZodError` 和领域错误到 HTTP 的映射；fallback code、状态码和响应正文存在差异。
- 影响：新增领域错误时需要逐个路由维护，容易返回错误状态或泄漏不一致的消息；大量样板代码降低路由可读性，违反 DRY。
- 建议方向：定义统一 `AppError`/error code 契约，通过 Fastify error handler 或插件集中映射认证、校验、冲突、限流和内部错误；领域服务只抛稳定错误，不依赖 HTTP reply。

### ENG-022：配置加载缺少统一 schema

- 严重度：P1
- 状态：已解决
- 证据：`config/env.ts` 手工读取和拼装大量环境变量；Worker 数值使用 `parseInt`，没有统一验证正数、范围或 `3abc` 等非严格输入。`packages/config` 仍为空壳，Web 与 Server 各自维护配置逻辑。
- 影响：增加 Provider 或部署参数时需要扩展类型、读取、默认值、示例和文档多个位置；无效配置可能在运行中才体现为异常并发数、轮询间隔或功能缺失。
- 建议方向：使用单一 schema 定义变量名、类型、默认值、范围、敏感性和适用进程，启动时 fail fast；从 schema 推导 `ServerEnv`，并生成/校验 `.env.example` 与部署文档。
- 落地：`@loomic/config` 现提供 Zod 4 schema 与安全描述符元数据；API/Worker 统一聚合校验，Worker 必需配置和显式 Provider 依赖在组合客户端前失败；工作区测试会校验 `.env.example`、Railway 与 Vercel 声明，且诊断不包含敏感值。

### ENG-023：模型元数据存在多个事实源

- 严重度：P1
- 状态：已确认
- 证据：Provider 文件维护模型能力，`packages/shared/src/credits.ts` 分别维护套餐门槛和价格，Agent tools、HTTP 路由、画布生成器、hooks 与设置页面又各自硬编码默认模型。
- 影响：新增、下线或重命名模型需要跨多层同步修改；一个模型可能能被展示但无法计价，或默认值指向未配置 Provider。该结构不符合开闭原则，也使模型扩展难以通过单点注册完成。
- 建议方向：建立规范化 model catalog，由每个模型声明 provider、媒体类型、能力、限制、套餐、计价规则和 fallback 排序；前端默认值与 Agent schema从可用 catalog 派生。定价若需独立治理，也应有自动完整性校验。

### ENG-024：扩展 registry 使用全局可变状态

- 严重度：P2
- 状态：已确认
- 证据：Provider 和 Executor 分别保存在模块级 `Map`；`buildApp` 每次调用都会执行 `registerAllProviders`，注册时同名条目直接覆盖且没有重复检测或生命周期隔离。
- 影响：测试、热重载、多应用实例和未来动态配置之间可能互相污染；依赖在函数签名中不可见，降低可测试性。重复 provider/model ID 也无法在启动时明确失败。
- 建议方向：保留 registry 模式，但改为由 composition root 创建的显式实例，启动时验证 provider 名、model ID 和 executor type 唯一性，再注入应用服务与 Worker。

### ENG-025：架构边界仅依靠目录约定

- 严重度：P2
- 状态：已确认
- 证据：当前 lint/tsconfig 未定义跨层 import 规则，Agent、HTTP、Worker 和 feature 模块可以直接访问 Supabase、queue 或其他 feature 内部实现；已有多处绕过 service 的实例。
- 影响：随着团队和功能增长，依赖方向会逐渐形成环和隐式耦合，目录分层无法阻止实现层反向依赖入口层；重构影响范围难以预测。
- 建议方向：明确 domain/application/infrastructure/interface 的允许依赖方向，用 package exports、目录 public API、dependency-cruiser 或等价 lint 规则自动约束，并在 CI 中加入循环依赖检查。

### ENG-026：跨包契约使用两个 Zod 主版本

- 严重度：P2
- 状态：已确认
- 证据：`@loomic/shared` 依赖 Zod 3，`@loomic/server` 直接依赖 Zod 4；服务端同时导入共享 schema 和本地 schema，并通过错误名称而非稳定统一类型判断 ZodError。
- 影响：错误类型、schema API 和类型推导行为可能不一致，升级时更容易出现难定位的兼容问题；重复运行时也增加依赖和认知成本。
- 建议方向：统一工作区 Zod 主版本，通过 workspace catalog/overrides 和依赖检查避免再次漂移；迁移前补充共享契约与错误处理兼容测试。

### ENG-027：Production execute 不是真正的安全沙箱

- 严重度：P0
- 状态：部分解决
- 证据：`agent/backends/prod.ts` 使用与 API/Worker 同容器的 `LocalShellBackend`。代码注释明确指出 `virtualMode` 只限制文件工具，不限制 `execute`；shell 仍可访问完整容器文件系统和网络。
- 影响：受用户提示、模型输出或外部 skill 影响的命令可以读取应用源码、`/proc`、挂载凭证和同容器文件，访问内网或发起外部攻击。按 DeepAgents 官方 production/sandboxes 指引，这种本地 shell 适合受信开发环境，不构成多租户隔离。
- 建议方向：生产执行迁移到一次性容器、microVM 或受支持的远端 sandbox provider；落实只读根文件系统、非 root 用户、seccomp/AppArmor、CPU/内存/PID/磁盘限额、网络默认拒绝、域名 allowlist、超时和销毁审计。完成隔离前应关闭面向不可信用户的 execute。
- 阶段 0 结果：危险的本地执行能力现已默认关闭，生产环境未精确配置允许开关时拒绝创建本地 Shell。真正的远端隔离执行环境仍列入阶段 3，因此本项保持“部分解决”。

### ENG-028：WebSocket 资源操作缺少对象级授权

- 严重度：P0
- 状态：已解决
- 证据：连接只验证 bearer token；`canvas.resume` 直接用客户端提供的 canvasId 绑定并回放 `CanvasEventBuffer`，没有查询画布成员关系；`agent.cancel` 直接按客户端 runId 调用 `cancelRun`；client-provided connectionId 也可覆盖既有连接索引。`handleRunCommand` 解析 session/thread 所有权失败时选择继续执行。
- 影响：已认证用户可能订阅其他租户画布事件、获取提示词/工具输出/生成结果，或取消不属于自己的运行；属于跨租户数据泄露和越权操作。
- 建议方向：所有 WS command 在执行前调用统一 authorization service，验证 session、canvas、run 与 authenticated user 的关系；连接绑定和 active run 必须带 tenant/user scope。客户端不得覆盖其他用户的 connection identity，所有权解析失败应 fail closed。
- 阶段 0 结果：已增加 canvas、session、run 的统一对象级授权；HTTP 与 WebSocket 的运行、恢复、取消均按认证用户校验，session 与请求 canvas 必须匹配且失败时关闭访问，不同用户也不能占用同一连接标识。真实数据库角色的跨工作区 RLS 测试和安全回归测试均通过，关闭于 2026-08-17。

### ENG-029：外部 URL 获取缺少完整 SSRF 与资源限制

- 严重度：P0
- 状态：已解决
- 证据：`image-proxy.ts` 使用 `hostname.endsWith(domain)`，可匹配非预期后缀域名，且未限制协议、重定向目标、响应大小、MIME 或超时；tarball skill 导入允许任意以 `.tgz/.tar.gz` 结尾的 URL并整体读入内存，GitHub 递归下载也没有总文件数/总字节限制。其他生成结果下载路径同样多为直接 `fetch`。
- 影响：攻击者可利用服务端网络访问内网、云 metadata 或恶意重定向目标，并通过超大响应、压缩炸弹或深层目录耗尽内存、CPU 和连接。
- 建议方向：建设统一 safe-fetch 服务：仅 HTTPS、精确主机/注册域匹配、DNS 解析后禁止私网/回环/link-local、每次重定向重新校验、连接与总超时、Content-Length/流式字节上限、MIME allowlist 和审计日志。Archive 解压增加 entry/深度/展开后总大小限制。
- 阶段 0 结果：图片代理和外部 Skill 下载已统一经过受限网络访问，覆盖协议、域名、DNS 私网、重定向、超时、类型和大小校验；压缩包同时限制条目数、单文件、总展开量和目录深度。相关测试通过，关闭于 2026-08-17。

### ENG-030：外部 Skill 与命令执行之间缺少供应链隔离

- 严重度：P0
- 状态：部分解决
- 证据：用户可从 GitHub、npm tarball 和 marketplace 导入包含 `SKILL.md`、scripts 与 references 的内容，并自动启用到 workspace；Agent 同时拥有不受容器隔离的 execute 能力。导入过程没有签名、固定 commit/integrity、恶意规则扫描或首次执行审批。
- 影响：仓库所有者更新、依赖劫持、恶意 README/SKILL 指令或 prompt injection 都可能转化为服务端命令执行和数据外传。
- 建议方向：将 skill 视为可执行供应链制品：记录不可变来源 hash/commit、签名和发布者信任等级；导入后默认禁用，展示权限清单和 diff；脚本执行需要 capability policy/HITL，社区 skill 只运行在真正隔离的 sandbox 中。
- 阶段 0 结果：外部导入能力已默认关闭；显式开启后导入的 Skill 也默认禁用并要求人工审阅，来源与下载范围受到约束。签名、不可变来源、权限清单和隔离执行仍列入阶段 3，因此本项保持“部分解决”。
- 阶段 1 进展：新增 transport-neutral `ImportSkill`，固定“能力闸门优先、来源校验后再调用既有安全 importer”的顺序，并在运行时强制 `requiresReview: true`、`enabled: false` 及来源身份一致。HTTP 持久化迁移和阶段 3 的签名/权限/隔离仍未完成，本项继续保持“部分解决”。

### ENG-031：高成本入口缺少统一限流和配额入口

- 严重度：P1
- 状态：已解决
- 证据：未发现 Fastify rate-limit 或等价中间件。登录后的 Agent run、生成、上传、skill 导入和 WebSocket command，以及无需认证的 image proxy/部分模型接口，主要依靠积分或局部并发检查。
- 影响：积分校验不能防止连接洪泛、代理带宽滥用、无效请求解析、外部 API 探测和并发数据库压力；单用户也可能意外启动过多运行。
- 建议方向：按 IP、user、workspace、endpoint cost 和并发维度实施分层 token bucket；WebSocket 限制连接数、消息大小和 command 速率；代理与导入使用更严格的全局并发和带宽预算。
- 阶段 0 结果：HTTP 已按用户或 IP 分组并为生成、代理、导入、上传设置差异化预算；WebSocket 已限制消息大小、速率和并行 Agent run，连续违规会关闭连接。回归测试通过，关闭于 2026-08-17。

### ENG-032：实时链路依赖单进程内存状态

- 严重度：P1
- 状态：已确认
- 证据：`ConnectionManager`、`CanvasEventBuffer`、activeRuns、pending RPC 和 Agent run 状态均保存在当前 API 进程内存；没有共享 pub/sub、持久 event cursor 或 replica ownership 协议。
- 影响：API 重启会丢失回放和活跃运行状态；多副本部署时连接到另一副本的用户收不到事件，重连也无法恢复。内存 buffer 默认每画布最多 5000 事件，活跃画布增加时内存不可预测。
- 建议方向：明确单副本限制并在部署层强制，或引入 Redis/Postgres/NATS 等共享事件层、持久 cursor 和 run ownership/lease；WebSocket 使用 sticky session 只能作为过渡，不解决故障恢复。

### ENG-033：认证缓存容量与失效策略不完整

- 严重度：P1
- 状态：已确认
- 证据：auth cache 以完整 token 为 key，TTL 5 分钟；超过 500 条时只删除已过期项，没有 LRU/最大容量强制淘汰，也没有登出、封禁、密钥轮换或用户状态变化的主动失效。
- 影响：大量有效或不同 token 可持续增加进程内存；已撤销会话在 TTL 内仍可能通过本地缓存。多副本间状态也不一致。
- 建议方向：优先依赖本地 JWT 的无状态验证并缩小缓存用途；若保留远程验证缓存，使用 token hash、硬容量 LRU、TTL 不超过 token exp，并建立撤销/用户禁用策略和监控。

### ENG-034：RLS 与索引性能尚未系统治理

- 严重度：P2
- 状态：已确认
- 证据：早期 foundation migration 已采用 `(select auth.uid())` 和 security-definer helper，但 workspace settings、chat、jobs、skills、credits 等后续 migration 仍多处在 policy 子查询中直接调用 `auth.uid()`。现有索引较完整，但未见自动检查全部外键、RLS predicate 和复合排序条件。
- 影响：数据量增长后，RLS 可能对每行重复求值并执行多表 EXISTS；未覆盖的外键或 `WHERE + ORDER BY` 查询会退化为扫描和排序。Supabase 最佳实践将这两类问题列为高影响项。
- 建议方向：通过真实 schema 的 catalog 查询检查缺失 FK/RLS 索引；将稳定函数调用改为 `(select auth.uid())`，对常用成员检查评估 security-definer helper；以 `EXPLAIN (ANALYZE, BUFFERS)` 验证高频列表和 RLS 查询。

### ENG-035：列表接口缺少一致分页

- 严重度：P2
- 状态：已确认
- 证据：chat sessions/messages、projects、brand kits、skills 和 workspace skill 查询多为全量读取；只有 jobs、credit history 和 marketplace 等少数接口设置 limit/page。
- 影响：长期使用后单次响应、React 渲染和 RLS 查询成本线性增长，尤其消息内容包含 blocks 和工具输出时会快速放大。
- 建议方向：为所有集合接口定义统一 cursor pagination、稳定排序和最大 page size；聊天消息采用倒序 cursor 获取最近窗口，前端虚拟化长列表并按需加载历史。

### ENG-036：健康检查不能反映服务可用性

- 严重度：P1
- 状态：已确认
- 证据：`/api/health` 无条件返回 `{ ok: true }`，不验证 Supabase、PGMQ、LangGraph persistence、Storage、Provider 配置或 Worker 心跳；未区分 liveness 与 readiness。
- 影响：数据库断连、队列不可用或 migration 缺失时编排平台仍会继续导流；Worker 卡死也缺少可检测信号。
- 建议方向：保留轻量 liveness，增加有短超时的 readiness；启动时校验 schema/migration 和必要配置；Worker 定期上报 heartbeat、队列 lag、最老消息年龄和执行槽位。

### ENG-037：数据库变更缺少自动交付验证

- 严重度：P2
- 状态：已确认
- 证据：仓库含大量顺序 migration、RLS、security-definer function 和生成类型，但测试流程未启动临时 Supabase 从零重建，也未执行 SQL lint、权限审计、类型再生成差异检查或升级路径验证。
- 影响：单个 migration 在空库可运行但在真实旧数据/旧函数签名上失败；RLS grant、search_path 和生成 TypeScript 类型漂移可能直到部署后才发现。
- 建议方向：CI 启动临时 Supabase，执行 reset/from-zero 与代表性升级 fixture，运行 RLS 正反权限测试、function privilege/search_path 检查，并确保生成 database types 无未提交差异。生产变更准备备份、回滚或 forward-fix runbook。

### ENG-038：前端服务端状态管理规则分散

- 严重度：P2
- 状态：已确认
- 证据：项目、设置、skills、brand kit、模型和聊天数据主要在页面/组件内以 `useEffect + useState + fetch` 管理；只有少量请求使用自定义 dedupe，缺少统一 query key、缓存、重试、取消和 mutation invalidation 机制。
- 影响：页面切换和多个组件消费同一资源时容易重复请求、显示陈旧数据或各自实现 loading/error；新增功能需要重复编写生命周期代码。
- 建议方向：引入统一 server-state 层（如项目选定的成熟 query library或轻量内部封装），集中 auth-aware fetch、schema parse、query key、重试与失效；本地交互状态继续留在组件，避免建立无边界全局 store。

## 验证基线

- 记录日期：2026-08-17
- 初次审查基线：typecheck 通过；测试共 89 个；lint 失败并报告约 14,902 个诊断。
- 阶段 0 验收基线：全新检出的干净副本使用锁定依赖安装后，`pnpm ci:check` 通过；Server 62、Web 52、Shared 27、Workspace 16 个测试（共 157 项）均通过；14 项数据库 RLS/权限测试通过；数据库迁移从零重建通过；生产镜像构建及容器内应用加载通过。
- lint 当前可作为门禁并成功通过，但约 465 条历史 warning 尚待后续阶段按模块清理。
- 完整验收证据见 `docs/tech/phase-0-verification.md`。
- 工作区在初次审查时已有未提交改动；本台账持续记录工作区实际状态，而不只记录 `HEAD`。

## 后续收集区

后续审查发现的新问题直接追加到总览和“已确认问题”章节。若证据尚不充分，先放在下表，完成核实后再升级为正式条目。

| 临时编号 | 发现日期 | 领域 | 现象 | 待核实内容 |
| --- | --- | --- | --- | --- |
| - | - | - | - | - |
