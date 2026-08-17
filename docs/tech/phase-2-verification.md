# Loomic 阶段 2 验收记录

## 结论

通过。阶段 2 在指定基线之上完成事务化提交与扣款、显式任务状态机、外部效果执行栅栏、人工补偿上限、Canvas revision/CAS、可信写入边界和事务 outbox。独立审查发现的问题由 `4df284d` 及后续 follow-up forward-fix，并完成全量复验。本文档不把本地数据库、Docker 入口或单进程 WebSocket 验证泛化为外部 Provider、生产多实例或阶段 5 实时基础设施验证。

## 基本信息

- 日期：2026-08-18
- 基线：`56215dfab34f1a77afc6d56e9942192652a3f36c`
- 阶段 2 实现提交：`196aad6` 至 `cba1e83`
- 独立审查修复：`4df284d`
- 独立审查 follow-up：`bc40b7f`
- Supabase CLI：2.114.0

## 已取得证据

| 项目 | 结果 |
| --- | --- |
| 数据库从零重建 | 通过，migration 从 foundation 顺序应用至 `20260818000004_phase2_review_followup.sql` |
| pgTAP | 通过，2 files / 62 tests |
| 真实 PostgreSQL 并发与故障注入 | 通过，7 tests；双连接 lease/Canvas race，5 个 owner-only failpoint |
| 工作区架构门禁 | 通过，85 tests |
| Server 全套 | 通过，41 files / 285 tests；真实 PostgreSQL 7 tests 在普通单测中按设计跳过 |
| Web 当前全套测试 | 通过，16 files / 74 tests |
| Shared / Config | 通过，39 / 29 tests |
| Worker/Outbox/Credit 聚焦 | 通过，3 files / 22 tests |

## 最终门禁

- `pnpm exec turbo run test --force`：8/8 tasks，0 cached；Server 285、Web 74、Shared 39、Config 29。
- `pnpm ci:check`：通过；Workspace 85，lint 0 error / 441 个历史 warning，typecheck/test/build 全部成功。
- `pnpm exec turbo run typecheck --force`：8/8 tasks，0 cached。
- `pnpm exec turbo run build --force`：5/5 tasks，0 cached；Next.js 15 个静态页面生成成功。
- `supabase db reset --yes`、`supabase test db`、`supabase db lint --level warning`：通过；62 个 pgTAP 断言，0 schema error。
- `pnpm --filter @loomic/server test:integration`：7/7 真实 PostgreSQL 并发与 failpoint 测试通过。
- Docker：`app-load-ok`；`dist/server.js`、`dist/worker.js` 通过 `node --check`；镜像 `sha256:ed86e971d2d30eec85b3b600a2c9a52963752717ea006c2f47c34ad410e7f7ae`。
- `git diff --check`：通过；自动退款与直接 Canvas content update 搜索无命中。

## 已知边界

- 当前 domain event inbox 去重是 API 单进程内结构，不是阶段 5 的共享实时基础设施。
- 人工补偿没有用户 HTTP 路由，因为代码库不存在可信管理员 HTTP 授权边界；通过受控 service-role 流程执行。
- 外部 Provider 和 Storage 不在 PostgreSQL 原子事务内。Worker 在调用 Provider 前持久化 `generation_effect_attempts`；如果进程在外部调用后失联，新租约不会猜测性重放，而是以 `ambiguous_external_effect` 进入可审计 dead letter。该策略保证不会自动重复外部效果，但不能把未知结果变成分布式原子成功。
- generation outbox 发布到当前 API 进程的用户连接；跨副本共享发布与持久 inbox 属于阶段 5。
- 本次未调用真实付费 Provider，验收证明本地状态、权限、并发、故障和生产入口，不证明外部供应商可用性。
