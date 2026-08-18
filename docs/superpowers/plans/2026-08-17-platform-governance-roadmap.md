# Loomic Platform Governance Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Loomic 从功能完整的开发项目治理为安全、可靠、可扩展并可持续发布的生产系统。

**Architecture:** 按风险优先顺序分成八个可独立验收的实施计划。每个阶段以前一阶段产生的稳定契约为输入，不并行修改共享核心；阶段完成后更新问题台账并建立下一阶段的详细文件级计划。

**Tech Stack:** TypeScript, Next.js 15, Fastify 5, DeepAgents/LangGraph, Supabase/PostgreSQL, PGMQ, Vitest, Playwright, Biome, Turborepo

---

## 阶段计划

| 顺序 | 阶段 | 主要交付 | 启动条件 | 完成条件 |
| --- | --- | --- | --- | --- |
| 0 | 安全与质量基线 | WS 授权、safe-fetch、入口限流、危险能力关闭、CI、真实构建 | 当前状态 | P0 外部攻击面关闭，干净 checkout 全门禁通过 |
| 1 | 契约与应用内核 | 统一 Zod/AppError/config/model catalog/use cases | 阶段 0 通过 | 所有入口复用应用用例，边界统一校验 |
| 2 | 数据库与一致性 | 状态机、幂等、outbox、积分事务、canvas revision、RLS | 阶段 1 契约稳定 | 重试/取消/并发测试全部通过 |
| 3 | Agent 隔离与内置 Skill | 远端隔离 sandbox、画布级 capability、仓库 manifest、移除动态 Skill | 阶段 0 临时关闭危险能力、阶段 2 canvas revision 可用 | 不可信代码无法访问应用容器和内网；Agent 不能跨画布；仅清单内置 Skill 可加载 |
| 4 | 画布领域模型 | 版本化节点、registry、patch、asset manifest | 阶段 2 revision 可用 | 新节点通过单点注册完成扩展 |
| 5 | 实时横向扩展 | 共享事件层、cursor replay、run ownership | 阶段 1 授权契约和阶段 2 run 状态稳定 | 双 API 副本与重启恢复测试通过 |
| 6 | 前端数据与模块化 | Query 层、分页、API 分域、大组件拆分 | 阶段 1 API 契约稳定、阶段 4 节点 registry 稳定 | 数据缓存/失效一致，关键 E2E 通过 |
| 7 | 可观测性与发布 | traces、metrics、readiness、负载测试、发布 runbook | 其他阶段完成 | 预发布验收与故障演练通过 |

## 执行规则

- [ ] 每个阶段建立独立实施计划、分支和验收记录。
- [ ] 每个行为修改遵循失败测试 -> 最小实现 -> 回归测试 -> 单一提交。
- [ ] 禁止在阶段 PR 中混入全仓格式化或无关目录迁移。
- [ ] 数据库阶段只重建开发/测试数据；阶段 3 动态 Skill schema 删除是产品批准的前滚例外，生产启用前仍需单独核对部署顺序。
- [ ] 每阶段结束更新 `docs/tech/engineering-issues-register.md` 的状态和验证证据。
- [ ] 阶段验收失败时停止后续共享核心改造，先修复当前阶段。

## 计划文件

- 阶段 0：`docs/superpowers/plans/2026-08-17-phase-0-security-quality-baseline.md`
- 阶段 1-2、4-7：在前置阶段完成后，根据已经落地的接口和文件路径分别生成，避免计划引用尚不存在或已变化的代码。
- 阶段 3：以 `docs/superpowers/specs/2026-08-18-builtin-skills-and-canvas-scoped-agent-design.md` 为唯一设计来源；旧阶段 3 设计和实施计划已删除，必须重写实施计划后才能执行。
