# 阶段 2 事务一致性运维 Runbook

## 适用边界

本手册覆盖 generation submission/charge/PGMQ、租约状态机、人工补偿、Canvas revision CAS 与 domain outbox。PGMQ 是至少一次投递；数据库事务不覆盖 Provider、Storage 或 WebSocket。禁止将本手册扩展解释为跨服务原子提交。

## 发布与回退

1. Expand：先应用 `20260818000000` 至 `20260818000004` migration。确认旧应用仍可读取 additive columns。
2. Switch：部署 API，再部署 Worker。确认新 submission 只调用 `submit_generation_job`，Worker 只调用 claim/renew/settle RPC。
3. Enforce：运行架构门禁、权限测试和抽样查询；禁止重新授权 authenticated 执行定价、租约、补偿或 outbox RPC。
4. 应用回退：schema 保持不回滚，回退到兼容版本；migration 只做 forward-fix。已存在 `cancel_requested` 的数据库不可回退到不理解该 enum 的写入程序。
5. 数据修复：不得删除 debit、compensation、effect receipt 或 outbox 审计行。通过新 migration/受审计脚本 forward-fix。

## 监控查询

```sql
-- 排队超过 10 分钟
select id, queue_name, attempt_count, created_at
from public.background_jobs
where status = 'queued' and created_at < now() - interval '10 minutes';

-- 过期或即将过期的活动租约
select id, status, lease_owner, lease_expires_at, attempt_count, max_attempts
from public.background_jobs
where status in ('running', 'cancel_requested')
  and lease_expires_at < now() + interval '30 seconds';

-- 未发布 outbox 的最大年龄与失败次数
select count(*) as pending, min(occurred_at) as oldest, max(attempt_count) as max_attempts
from public.domain_outbox where published_at is null;

-- Canvas 冲突趋势由结构化日志 canvas_revision_conflict 聚合；当前 revision
select id, revision, updated_at from public.canvases where id = :canvas_id;

-- 人工补偿审计
select compensation_key, workspace_id, job_id, debit_transaction_id,
       operator_user_id, amount, reason, refund_transaction_id, completed_at
from public.credit_compensations where job_id = :job_id;

-- Provider 调用已经开始但结果不明确，禁止自动重放
select j.id, j.status, j.error_code, a.state, a.started_at, a.lease_token
from public.background_jobs j
join public.generation_effect_attempts a on a.job_id = j.id
where a.state = 'ambiguous';
```

告警建议：oldest outbox > 2 分钟、活动租约过期 > 0、queued > 10 分钟、同 job stale lease 连续出现、Canvas 409 比率突增、补偿 RPC 失败。日志不得包含 prompt、payload、access token 或原始 lease token。

## 事件重放

仅重放 `published_at is null` 的 outbox。先记录 event_id/aggregate/version，再清除过期锁并设置 `available_at = now()`；不要复制事件行。发布可能在 ack 前成功，因此消费者必须按 event_id 幂等。当前 WebSocket inbox 仅为单 API 进程内去重；多实例共享 replay 属于后续阶段。

```sql
update public.domain_outbox
set locked_at = null, locked_by = null, available_at = now()
where event_id = :event_id and published_at is null;
```

## 人工补偿

取消、超时、失败和 dead letter 均不自动退款。只有授权人工操作员可补偿：

1. 核验原 job、`credits_transaction_id`、`credits_cost` 和原 `generation_deduct` ledger。
2. 创建不可复用的工单键作为 `compensation_key`，记录 operator、amount、reason。
3. 在受控 service-role 后台调用 `compensate_generation_charge`；普通用户 HTTP 不暴露该能力。
4. 同键重试必须返回原 transaction 且 `replayed=true`；参数不同应为 `compensation_conflict`。
5. 数据库会锁定原 debit，并拒绝单次或累计补偿超过原扣款；核验 balance version 增加一次、refund ledger 一条、audit completed_at/refund_transaction_id 完整。

## 故障处置

- Provider 调用前 Worker 必须成功写入 effect attempt。调用开始后进程失联或结果不明确时，后续租约禁止再次调用 Provider，任务进入 `ambiguous_external_effect` dead letter，由人工核对供应商与 Storage 后 forward-fix；不得直接删除 attempt 或重新排队。
- 取消到达时若 Provider 尚未开始，可安全进入 `canceled`；若成功结果已提交，成功优先；若外部效果状态不明确，进入 dead letter，不能伪装为 `canceled`。
- 结算成功但消息删除失败：消息会重现；terminal claim 直接删除，不重复业务效果。
- Canvas CAS 冲突：浏览器不重试整文档；Agent 仅重放可重放操作，最多三次。
- Storage 上传后 CAS 耗尽：记录 object path 为 orphan candidate，人工核验引用后再清理。
- outbox 发布后 ack 失败：允许重复发布，按 event_id 去重。
