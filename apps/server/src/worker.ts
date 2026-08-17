// @credits-system — Worker process: handles job failure refunds (credit refund on generation error)
import { bootstrap } from "global-agent";

// Enable HTTP proxy for all outbound requests if GLOBAL_AGENT_HTTP_PROXY is set
bootstrap();

// Native fetch() proxy — needed for @google/generative-ai SDK
if (process.env.GLOBAL_AGENT_HTTP_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(process.env.GLOBAL_AGENT_HTTP_PROXY));
}

import { randomUUID } from "node:crypto";
import { loadServerEnv } from "./config/env.js";
import {
  type CreditService,
  createCreditService,
} from "./features/credits/credit-service.js";
import { registerAllExecutors } from "./features/jobs/executors/register-all.js";
import type {
  ExecutorCatalog,
  ExecutorContext,
} from "./features/jobs/job-executor.js";
import { createJobService } from "./features/jobs/job-service.js";
import {
  resolveGenerationQueueMessage,
  settleNonReadyGenerationQueueMessage,
} from "./features/jobs/queue-message.js";
import { type PgmqMessage, createPgmqClient } from "./queue/pgmq-client.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import { createUserSupabaseClientFactory } from "./supabase/user.js";

// Register all image/video providers via shared helper (keeps parity with app.ts)
import { registerAllProviders } from "./generation/providers/register-all.js";

// 代码执行由 LocalShellBackend 的内置 execute 工具直接处理，不走 PGMQ。
const QUEUES = ["image_generation_jobs", "video_generation_jobs"] as const;

const VT_BY_QUEUE: Record<string, number> = {
  image_generation_jobs: 120,
  video_generation_jobs: 300,
};

async function main() {
  const env = loadServerEnv({}, process.env, { process: "worker" });

  // Register all generation providers (shared with app.ts)
  const providerRegistry = registerAllProviders(env);
  const executorRegistry = registerAllExecutors(providerRegistry);

  const { supabaseDbUrl } = env;
  if (!supabaseDbUrl) {
    // Defensive invariant: worker-mode schema validation above requires this.
    throw new Error(
      "Validated worker configuration is missing SUPABASE_DB_URL",
    );
  }
  const pgmq = createPgmqClient(supabaseDbUrl);
  const createUserClient = createUserSupabaseClientFactory(env);

  let adminClient: ReturnType<typeof createAdminSupabaseClient> | undefined;
  const getAdminClient = () => {
    adminClient ??= createAdminSupabaseClient(env);
    return adminClient;
  };

  const jobService = createJobService({
    createUserClient,
    getAdminClient,
  });
  const creditService = createCreditService({ getAdminClient });

  // Base context — per-message fields (queue, msgId, renewVt) are added in processMessage
  const baseCtx = {
    jobService,
    pgmq,
    getAdminClient,
    env,
  };

  const CONCURRENCY_BY_QUEUE: Record<string, number> = {
    image_generation_jobs: env.workerImageConcurrency ?? 3,
    video_generation_jobs: env.workerVideoConcurrency ?? 2,
  };

  const inFlightByQueue = new Map<string, Set<Promise<void>>>(
    QUEUES.map((q) => [q, new Set()]),
  );

  // Server-side long poll: wait up to N seconds inside Postgres for messages,
  // checking every 500ms. This replaces the old client-side sleep(2000) + read()
  // pattern that generated ~340K idle queries per monitoring period.
  const pollTimeoutSeconds = Math.max(
    1,
    Math.floor((env.workerPollIntervalMs ?? 5000) / 1000),
  );
  const workerId = env.workerId ?? randomUUID().slice(0, 8);
  const tag = `[worker:${workerId}]`;

  let running = true;

  // Graceful shutdown — wait for in-flight jobs then exit
  const shutdown = async () => {
    const totalInFlight = [...inFlightByQueue.values()].reduce(
      (n, s) => n + s.size,
      0,
    );
    console.log(
      `${tag} Shutting down, waiting for ${totalInFlight} in-flight jobs...`,
    );
    running = false;
    const allTasks = [...inFlightByQueue.values()].flatMap((s) => [...s]);
    if (allTasks.length > 0) {
      await Promise.allSettled(allTasks);
    }
    await pgmq.shutdown();
    console.log(`${tag} Shutdown complete.`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const concurrencyDesc = QUEUES.map(
    (q) => `${q}=${CONCURRENCY_BY_QUEUE[q] ?? 1}`,
  ).join(", ");
  console.log(
    `${tag} Started. concurrency={${concurrencyDesc}}, longPollTimeout=${pollTimeoutSeconds}s`,
  );

  while (running) {
    for (const queue of QUEUES) {
      try {
        const inFlight = inFlightByQueue.get(queue)!;
        const cap = CONCURRENCY_BY_QUEUE[queue] ?? 1;
        const available = cap - inFlight.size;
        if (available <= 0) continue;

        const vt = VT_BY_QUEUE[queue] ?? 120;
        const messages = await pgmq.readWithPoll(
          queue,
          vt,
          available,
          pollTimeoutSeconds,
          500,
        );

        for (const msg of messages) {
          const ctx: ExecutorContext = {
            ...baseCtx,
            queue,
            msgId: msg.msg_id,
            renewVt: async (vtSeconds: number) => {
              try {
                await pgmq.setVt(queue, msg.msg_id, vtSeconds);
              } catch (e) {
                console.warn(`[renewVt] failed for msg ${msg.msg_id}:`, e);
              }
            },
          };
          const task = processMessage(
            queue,
            msg,
            ctx,
            creditService,
            executorRegistry,
            tag,
          ).finally(() => inFlight.delete(task));
          inFlight.add(task);
        }
      } catch (err) {
        console.error(`${tag} Error polling ${queue}:`, err);
      }
    }
  }
}

async function processMessage(
  queue: string,
  msg: PgmqMessage,
  ctx: ExecutorContext,
  creditService: CreditService,
  executorRegistry: ExecutorCatalog,
  tag: string,
) {
  const resolution = await resolveGenerationQueueMessage({
    queue,
    message: msg.message,
    lookupJob: (jobId) => ctx.jobService.getJobAdmin(jobId),
  });
  if (resolution.status !== "ready") {
    const logFields = {
      code: resolution.code,
      queue,
      msgId: msg.msg_id,
      ...("jobId" in resolution ? { jobId: resolution.jobId } : {}),
    };
    if (resolution.status === "retryable") {
      console.warn(`${tag} Queue message deferred`, logFields);
    } else {
      console.error(`${tag} Queue message rejected`, logFields);
    }
    await settleNonReadyGenerationQueueMessage(resolution, {
      markDeadLetter: (jobId, code, message) =>
        ctx.jobService.markDeadLetter(jobId, code, message),
      archive: () => ctx.pgmq.archive(queue, msg.msg_id),
      refund: (jobId) => refundDeadLetteredJob(jobId, ctx, creditService, tag),
    });
    return;
  }
  const { jobId, jobType, payload } = resolution.dispatch;

  // Extract traceability context from PGMQ message (if present)
  const sessionShort =
    typeof payload.session_id === "string"
      ? payload.session_id.slice(0, 8)
      : undefined;
  const startTime = Date.now();
  console.log(
    `${tag} Processing job ${jobId} (${jobType})${sessionShort ? ` session:${sessionShort}` : ""}`,
  );

  const executor = executorRegistry.get(jobType);
  if (!executor) {
    console.error(`${tag} No executor for job type: ${jobType}`);
    await ctx.jobService.markFailed(
      jobId,
      "no_executor",
      `No executor registered for ${jobType}`,
    );
    await ctx.pgmq.archive(queue, msg.msg_id);
    return;
  }

  // Increment attempt count
  const { attempt_count, max_attempts } =
    await ctx.jobService.incrementAttempt(jobId);

  // Mark running
  await ctx.jobService.markRunning(jobId);

  try {
    const result = await executor(jobId, payload, ctx);
    await ctx.jobService.markSucceeded(jobId, result);
    await ctx.pgmq.deleteMsg(queue, msg.msg_id);
    console.log(`${tag} Job ${jobId} succeeded +${Date.now() - startTime}ms`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = (err as { code?: string })?.code ?? "executor_error";

    // Non-retryable errors: retrying with the same input will always fail.
    // Dead-letter immediately so the caller (agent polling) gets fast feedback.
    const NON_RETRYABLE_CODES = new Set([
      "invalid_input",
      "model_not_found",
      "provider_not_found",
      "safety_filter",
    ]);
    const shouldDeadLetter =
      attempt_count >= max_attempts || NON_RETRYABLE_CODES.has(errorCode);

    if (shouldDeadLetter) {
      await ctx.jobService.markDeadLetter(jobId, errorCode, errorMessage);
      await ctx.pgmq.archive(queue, msg.msg_id);

      // Auto-refund credits for dead-lettered jobs
      await refundDeadLetteredJob(jobId, ctx, creditService, tag);

      console.error(
        `${tag} Job ${jobId} dead-lettered after ${attempt_count} attempts +${Date.now() - startTime}ms: ${errorMessage}`,
      );
    } else {
      await ctx.jobService.markFailed(jobId, errorCode, errorMessage);
      // Message will re-appear after VT expires for retry
      console.warn(
        `${tag} Job ${jobId} failed (attempt ${attempt_count}/${max_attempts}) +${Date.now() - startTime}ms: ${errorMessage}`,
      );
    }
  }
}

/**
 * Refund credits for a dead-lettered job if credits were deducted.
 * Only dead-lettered (permanently failed) jobs get refunds — not cancelled jobs.
 */
async function refundDeadLetteredJob(
  jobId: string,
  ctx: ExecutorContext,
  creditService: CreditService,
  tag: string,
) {
  try {
    const admin = ctx.getAdminClient();
    const { data: jobRow } = await admin
      .from("background_jobs")
      .select("credits_cost, workspace_id, created_by")
      .eq("id", jobId)
      .single();

    if (!jobRow) return;

    const creditsCost = jobRow.credits_cost ?? 0;
    const workspaceId = jobRow.workspace_id;
    const createdBy = jobRow.created_by;

    if (creditsCost <= 0 || !workspaceId || !createdBy) return;

    const txId = await creditService.refundCredits(
      workspaceId,
      createdBy,
      creditsCost,
      jobId,
      "Auto-refund: job failed",
    );
    console.log(
      `${tag} Refunded ${creditsCost} credits for job ${jobId} (tx: ${txId})`,
    );
  } catch (refundErr) {
    // Log but don't crash the worker — the job is already dead-lettered
    console.error(
      `${tag} Failed to refund credits for job ${jobId}:`,
      refundErr,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
