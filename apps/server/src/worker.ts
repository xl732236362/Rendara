// Generation worker: leased execution with at-least-once queue delivery.
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
import { registerAllExecutors } from "./features/jobs/executors/register-all.js";
import type {
  ExecutorCatalog,
  ExecutorContext,
} from "./features/jobs/job-executor.js";
import { createJobService } from "./features/jobs/job-service.js";
import { createJobStateRepository } from "./features/jobs/job-state-repository.js";
import {
  resolveGenerationQueueMessage,
  settleNonReadyGenerationQueueMessage,
} from "./features/jobs/queue-message.js";
import { createWorkerJobLifecycle } from "./features/jobs/worker-job-lifecycle.js";
import { type PgmqMessage, createPgmqClient } from "./queue/pgmq-client.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import { createUserSupabaseClientFactory } from "./supabase/user.js";

// Register all image/video providers via shared helper (keeps parity with app.ts)
import { registerAllProviders } from "./generation/providers/register-all.js";

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
  const jobStateRepository = createJobStateRepository({
    createUserClient,
    getAdminClient,
  });

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
            jobStateRepository,
            executorRegistry,
            tag,
            workerId,
            vt,
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
  jobStateRepository: ReturnType<typeof createJobStateRepository>,
  executorRegistry: ExecutorCatalog,
  tag: string,
  workerId: string,
  leaseSeconds: number,
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
        settleRejectedJob(
          jobStateRepository,
          jobId,
          workerId,
          leaseSeconds,
          code,
          message,
        ),
      archive: () => ctx.pgmq.archive(queue, msg.msg_id),
    });
    return;
  }
  const { jobId, jobType, payload } = resolution.dispatch;

  const logger = {
    info: (event: string, fields: Record<string, unknown>) =>
      console.log(JSON.stringify({ level: "info", event, ...fields })),
    warn: (event: string, fields: Record<string, unknown>) =>
      console.warn(JSON.stringify({ level: "warn", event, ...fields })),
    error: (event: string, fields: Record<string, unknown>) =>
      console.error(JSON.stringify({ level: "error", event, ...fields })),
  };
  const lifecycle = createWorkerJobLifecycle({
    jobs: jobStateRepository,
    workerId,
    leaseSeconds,
    logger,
    queue: {
      deleteMessage: (name, messageId) => ctx.pgmq.deleteMsg(name, messageId),
      archiveMessage: (name, messageId) => ctx.pgmq.archive(name, messageId),
      renewMessage: (name, messageId, seconds) =>
        ctx.pgmq.setVt(name, messageId, seconds),
    },
    executor: async (id, type, authoritativePayload) => {
      const executor = executorRegistry.get(type);
      if (!executor) {
        throw Object.assign(new Error("Generation executor is unavailable."), {
          code: "no_executor",
        });
      }
      return executor(id, authoritativePayload, ctx);
    },
  });
  await lifecycle.process({
    jobId,
    jobType,
    payload,
    queue,
    messageId: msg.msg_id,
  });
}

async function settleRejectedJob(
  jobs: ReturnType<typeof createJobStateRepository>,
  jobId: string,
  workerId: string,
  leaseSeconds: number,
  errorCode: string,
  errorMessage: string,
) {
  const claim = await jobs.claim(jobId, workerId, leaseSeconds);
  if (claim.kind === "missing" || claim.kind === "terminal") return;
  if (claim.kind === "busy") {
    throw Object.assign(new Error("Job is already leased."), {
      code: "stale_job_lease",
    });
  }
  await jobs.settle({
    jobId,
    leaseToken: claim.lease_token,
    outcome: "dead_letter",
    errorCode,
    errorMessage,
  });
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
