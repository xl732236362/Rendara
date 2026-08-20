import { createHash } from "node:crypto";

import type { BackgroundJobType } from "@loomic/shared";

import type { JobStateRepository } from "./job-state-repository.js";

type LifecycleMessage = {
  jobId: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
  queue: string;
  messageId: number;
};

type LifecycleLogger = {
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
};

type LifecycleDisposition =
  | "missing"
  | "busy"
  | "duplicate_terminal"
  | "succeeded"
  | "canceled"
  | "retry"
  | "dead_lettered"
  | "stale";

const NON_RETRYABLE_CODES = new Set([
  "invalid_input",
  "model_not_found",
  "provider_not_found",
  "no_executor",
  "safety_filter",
]);

export function createWorkerJobLifecycle(options: {
  jobs: Pick<JobStateRepository, "claim" | "beginEffect" | "renew" | "settle">;
  executor(
    jobId: string,
    jobType: BackgroundJobType,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  queue: {
    deleteMessage(queue: string, messageId: number): Promise<unknown>;
    archiveMessage(queue: string, messageId: number): Promise<unknown>;
    renewMessage(
      queue: string,
      messageId: number,
      leaseSeconds: number,
    ): Promise<unknown>;
  };
  workerId: string;
  leaseSeconds: number;
  logger: LifecycleLogger;
  attachmentReconciler?: { wake(): void };
}) {
  const settleAndWake = async (
    command: Parameters<typeof options.jobs.settle>[0],
  ) => {
    const settlement = await options.jobs.settle(command);
    if (
      settlement.job.status === "succeeded" ||
      settlement.job.status === "canceled" ||
      settlement.job.status === "dead_letter"
    ) {
      options.attachmentReconciler?.wake();
    }
    return settlement;
  };
  return {
    async process(
      message: LifecycleMessage,
    ): Promise<{ disposition: LifecycleDisposition }> {
      const startedAt = Date.now();
      const context = {
        event: "generation_job_process",
        jobId: message.jobId,
        jobType: message.jobType,
        queue: message.queue,
        messageId: message.messageId,
        workerId: options.workerId,
      };
      const claim = await options.jobs.claim(
        message.jobId,
        options.workerId,
        options.leaseSeconds,
      );
      if (claim.kind === "missing") {
        await options.queue.archiveMessage(message.queue, message.messageId);
        return { disposition: "missing" };
      }
      if (claim.kind === "busy") return { disposition: "busy" };
      if (claim.kind === "terminal") {
        await options.queue.deleteMessage(message.queue, message.messageId);
        return { disposition: "duplicate_terminal" };
      }

      const leaseContext = {
        ...context,
        attempt: claim.job.attempt_count,
        leaseDigest: digestLease(claim.lease_token),
      };
      const renewal = startRenewal({
        renew: () =>
          Promise.all([
            options.jobs.renew(
              message.jobId,
              claim.lease_token,
              options.leaseSeconds,
            ),
            options.queue.renewMessage(
              message.queue,
              message.messageId,
              options.leaseSeconds,
            ),
          ]),
        intervalMs: Math.max(
          1_000,
          Math.floor((options.leaseSeconds * 1_000) / 3),
        ),
        logger: options.logger,
        context: leaseContext,
      });
      try {
        const effect = await options.jobs.beginEffect(
          message.jobId,
          claim.lease_token,
        );
        if (effect.kind === "completed") {
          await settleAndWake({
            jobId: message.jobId,
            leaseToken: claim.lease_token,
            outcome: "succeeded",
            result: effect.result,
          });
          await options.queue.deleteMessage(message.queue, message.messageId);
          return { disposition: "succeeded" };
        }
        if (effect.kind === "ambiguous") {
          await settleAndWake({
            jobId: message.jobId,
            leaseToken: claim.lease_token,
            outcome: "dead_letter",
            errorCode: "ambiguous_external_effect",
            errorMessage: "External generation replay was blocked.",
          });
          await options.queue.archiveMessage(message.queue, message.messageId);
          options.logger.error("generation_job_ambiguous_effect", leaseContext);
          return { disposition: "dead_lettered" };
        }
        if (effect.kind === "canceled") {
          await settleAndWake({
            jobId: message.jobId,
            leaseToken: claim.lease_token,
            outcome: "canceled",
          });
          await options.queue.deleteMessage(message.queue, message.messageId);
          return { disposition: "canceled" };
        }
        let result: Record<string, unknown>;
        try {
          result = await options.executor(
            message.jobId,
            message.jobType,
            message.payload,
          );
        } catch (error) {
          const errorCode = safeErrorCode(error);
          const deadLetter =
            claim.job.attempt_count >= claim.job.max_attempts ||
            NON_RETRYABLE_CODES.has(errorCode);
          let settlement;
          try {
            settlement = await settleAndWake({
              jobId: message.jobId,
              leaseToken: claim.lease_token,
              outcome: deadLetter ? "dead_letter" : "failed",
              errorCode,
              errorMessage: "Generation execution failed.",
            });
          } catch (settleError) {
            if (hasCode(settleError, "stale_job_lease")) {
              return { disposition: "stale" };
            }
            throw settleError;
          }
          const settledAsDeadLetter = settlement.job.status === "dead_letter";
          if (deadLetter || settledAsDeadLetter) {
            await options.queue.archiveMessage(
              message.queue,
              message.messageId,
            );
          }
          const finalDeadLetter = deadLetter || settledAsDeadLetter;
          options.logger[finalDeadLetter ? "error" : "warn"](
            "generation_job_failed",
            {
              ...leaseContext,
              disposition: finalDeadLetter ? "dead_lettered" : "retry",
              durationMs: Date.now() - startedAt,
              errorCode,
            },
          );
          return { disposition: finalDeadLetter ? "dead_lettered" : "retry" };
        }

        let settlement;
        try {
          settlement = await settleAndWake({
            jobId: message.jobId,
            leaseToken: claim.lease_token,
            outcome: "succeeded",
            result,
          });
        } catch (error) {
          if (hasCode(error, "stale_job_lease")) {
            options.logger.warn("generation_job_stale_result", leaseContext);
            return { disposition: "stale" };
          }
          throw error;
        }
        await options.queue.deleteMessage(message.queue, message.messageId);
        const disposition =
          settlement.job.status === "canceled" ? "canceled" : "succeeded";
        options.logger.info("generation_job_settled", {
          ...leaseContext,
          disposition,
          durationMs: Date.now() - startedAt,
        });
        return { disposition };
      } finally {
        renewal.stop();
      }
    },
  };
}

function startRenewal(options: {
  renew(): Promise<unknown>;
  intervalMs: number;
  logger: LifecycleLogger;
  context: Record<string, unknown>;
}) {
  const timer = setInterval(() => {
    void options.renew().catch((error) => {
      options.logger.warn("generation_job_lease_renewal_failed", {
        ...options.context,
        errorCode: safeErrorCode(error),
      });
    });
  }, options.intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

function digestLease(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code.slice(0, 100)
    : "executor_error";
}
