import type {
  GeneratedAssetAttachmentIntent,
  GeneratedAssetAttachmentRepository,
} from "./generated-asset-attachment-repository.js";

const RETRY_DELAYS_SECONDS = [1, 2, 4, 8, 16, 32, 60, 60] as const;
const DETERMINISTIC_FAILURES = new Set([
  "attachment_integrity_failure",
  "attachment_intent_not_found",
  "canvas_not_found",
]);

export type GeneratedAssetAttachmentPreparation =
  | {
      kind: "ready";
      element: Record<string, unknown>;
      file: Record<string, unknown> | null;
    }
  | {
      kind: "terminal_without_asset";
      outcome: "canceled" | "failed";
      errorCode: string;
    };

type ReconcilerLogger = {
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
};

export function createGeneratedAssetAttachmentReconciler(options: {
  repository: Pick<
    GeneratedAssetAttachmentRepository,
    "claim" | "fulfill" | "settle"
  >;
  templates: {
    prepare(
      intent: GeneratedAssetAttachmentIntent,
    ): Promise<GeneratedAssetAttachmentPreparation>;
  };
  workerId: string;
  logger: ReconcilerLogger;
  now?: () => Date;
  scanIntervalMs?: number;
  claimLeaseSeconds?: number;
  batchSize?: number;
}) {
  const now = options.now ?? (() => new Date());
  const scanIntervalMs = options.scanIntervalMs ?? 5_000;
  const claimLeaseSeconds = options.claimLeaseSeconds ?? 30;
  const batchSize = options.batchSize ?? 20;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeScan: Promise<ReconciliationSummary> | undefined;
  let started = false;

  const reconcileOnce = (): Promise<ReconciliationSummary> => {
    if (activeScan) return activeScan;
    activeScan = runScan().finally(() => {
      activeScan = undefined;
    });
    return activeScan;
  };

  return {
    reconcileOnce,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      await reconcileOnce();
      if (!started) return;
      timer = setInterval(() => void reconcileOnce(), scanIntervalMs);
      timer.unref();
    },
    wake(): void {
      if (!started) return;
      queueMicrotask(() => void reconcileOnce());
    },
    async stop(): Promise<void> {
      started = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      await activeScan;
    },
  };

  async function runScan(): Promise<ReconciliationSummary> {
    const claimed = await options.repository.claim({
      workerId: options.workerId,
      limit: batchSize,
      leaseSeconds: claimLeaseSeconds,
      now: now(),
    });
    const summary: ReconciliationSummary = {
      claimed: claimed.length,
      attached: 0,
      retried: 0,
      failed: 0,
    };
    for (const intent of claimed) {
      const outcome = await reconcileIntent(intent);
      summary[outcome] += 1;
    }
    if (claimed.length > 0) {
      options.logger.info("generated_asset_attachment_scan_completed", {
        workerId: options.workerId,
        ...summary,
      });
    }
    return summary;
  }

  async function reconcileIntent(
    intent: GeneratedAssetAttachmentIntent,
  ): Promise<"attached" | "retried" | "failed"> {
    const context = {
      intentId: intent.id,
      jobId: intent.job_id,
      canvasId: intent.canvas_id,
      claimFence: intent.claim_fencing_token,
      attemptCount: intent.attempt_count,
    };
    try {
      const prepared = await options.templates.prepare(intent);
      if (prepared.kind === "terminal_without_asset") {
        await options.repository.settle({
          intentId: intent.id,
          claimFence: intent.claim_fencing_token,
          outcome: prepared.outcome,
          errorCode: prepared.errorCode,
        });
        options.logger.warn("generated_asset_attachment_not_fulfilled", {
          ...context,
          outcome: prepared.outcome,
          errorCode: prepared.errorCode,
        });
        return "failed";
      }
      const receipt = await options.repository.fulfill({
        intentId: intent.id,
        claimFence: intent.claim_fencing_token,
        element: prepared.element,
        file: prepared.file,
        agentAttemptId: intent.attempt_id,
        agentFencingToken: intent.fencing_token,
      });
      options.logger.info("generated_asset_attachment_fulfilled", {
        ...context,
        elementId: receipt.elementId,
        canvasRevision: receipt.canvasRevision,
        replayed: receipt.replayed,
      });
      return "attached";
    } catch (error) {
      const errorCode = attachmentErrorCode(error);
      if (errorCode === "stale_attachment_claim") {
        options.logger.warn("generated_asset_attachment_claim_stale", {
          ...context,
          errorCode,
        });
        return "failed";
      }
      if (DETERMINISTIC_FAILURES.has(errorCode)) {
        await options.repository.settle({
          intentId: intent.id,
          claimFence: intent.claim_fencing_token,
          outcome: "failed",
          errorCode,
        });
        options.logger.error("generated_asset_attachment_failed", {
          ...context,
          errorCode,
          retryable: false,
        });
        return "failed";
      }
      if (intent.attempt_count >= RETRY_DELAYS_SECONDS.length) {
        await options.repository.settle({
          intentId: intent.id,
          claimFence: intent.claim_fencing_token,
          outcome: "failed",
          errorCode: "attachment_attempts_exhausted",
        });
        options.logger.error("generated_asset_attachment_failed", {
          ...context,
          errorCode: "attachment_attempts_exhausted",
          retryable: false,
        });
        return "failed";
      }
      const delaySeconds =
        RETRY_DELAYS_SECONDS[Math.max(0, intent.attempt_count - 1)] ?? 60;
      await options.repository.settle({
        intentId: intent.id,
        claimFence: intent.claim_fencing_token,
        outcome: "retry_wait",
        errorCode,
        nextAttemptAt: new Date(now().getTime() + delaySeconds * 1_000),
      });
      options.logger.warn("generated_asset_attachment_retry_scheduled", {
        ...context,
        errorCode,
        delaySeconds,
      });
      return "retried";
    }
  }
}

type ReconciliationSummary = {
  claimed: number;
  attached: number;
  retried: number;
  failed: number;
};

function attachmentErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const extended = error as Error & {
      attachmentErrorCode?: unknown;
      code?: unknown;
    };
    const value = extended.attachmentErrorCode ?? extended.code;
    if (typeof value === "string" && value.length > 0) {
      return value.slice(0, 64);
    }
  }
  return "attachment_infrastructure_error";
}
