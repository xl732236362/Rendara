import type {
  ExpiredRunRecoveryRequest,
  ExpiredRunRecoveryResult,
} from "./agent-execution-repository.js";

type RecoveryRepository = {
  recoverExpiredRuns(
    input: ExpiredRunRecoveryRequest,
  ): Promise<readonly ExpiredRunRecoveryResult[]>;
};

type RecoveryLogger = {
  info(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
};

export function createExpiredAgentRunRecovery(options: {
  repository: RecoveryRepository;
  intervalMs?: number;
  graceMs?: number;
  limit?: number;
  now?: () => Date;
  logger?: RecoveryLogger;
}) {
  const intervalMs = options.intervalMs ?? 5_000;
  const graceMs = options.graceMs ?? 30_000;
  const limit = options.limit ?? 25;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? {
    info: () => undefined,
    error: () => undefined,
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let stopped = false;

  const scan = async () => {
    try {
      const recovered = await options.repository.recoverExpiredRuns({
        graceMs,
        limit,
        now: now(),
      });
      for (const item of recovered) {
        logger.info("agent.run.expired_recovered", {
          attemptId: item.attemptId,
          runId: item.runId,
        });
      }
    } catch {
      logger.error("agent.run.expired_recovery_failed", {
        errorCode: "expired_run_recovery_failed",
      });
    }
  };

  const trigger = () => {
    if (stopped || active) return active ?? Promise.resolve();
    active = scan().finally(() => {
      active = undefined;
    });
    return active;
  };

  return {
    async start() {
      if (timer) return;
      stopped = false;
      await trigger();
      timer = setInterval(() => void trigger(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await active;
    },
  };
}
