import type { BackgroundJobType } from "@loomic/shared";

import type { ServerEnv } from "../../config/env.js";
import type { PgmqClient } from "../../queue/pgmq-client.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { JobService } from "./job-service.js";

export type ExecutorContext = {
  jobService: JobService;
  pgmq: PgmqClient;
  getAdminClient: () => AdminSupabaseClient;
  env: ServerEnv;
  /** PGMQ queue name for the current job (set per-message by the worker). */
  queue: string;
  /** PGMQ message id for the current job (set per-message by the worker). */
  msgId: number;
  /**
   * Best-effort VT renewal — extends visibility timeout so the message
   * stays invisible while the executor is still working.
   * Never throws; logs on failure.
   */
  renewVt: (vtSeconds: number) => Promise<void>;
};

export type JobExecutor = (
  jobId: string,
  payload: Record<string, unknown>,
  ctx: ExecutorContext,
) => Promise<Record<string, unknown>>;

/** Read-only executor capabilities exposed to worker dispatch. */
export interface ExecutorCatalog {
  get(jobType: BackgroundJobType): JobExecutor | undefined;
  listJobTypes(): BackgroundJobType[];
}

export class ExecutorRegistry implements ExecutorCatalog {
  readonly #executors = new Map<BackgroundJobType, JobExecutor>();
  #sealed = false;

  register(jobType: BackgroundJobType, executor: JobExecutor): this {
    if (this.#sealed) throw new Error("Executor registry is sealed");
    if (this.#executors.has(jobType)) {
      throw new Error(`Duplicate executor job type: "${jobType}"`);
    }
    this.#executors.set(jobType, executor);
    return this;
  }

  get(jobType: BackgroundJobType): JobExecutor | undefined {
    return this.#executors.get(jobType);
  }

  listJobTypes(): BackgroundJobType[] {
    return [...this.#executors.keys()].sort();
  }

  seal(): this {
    this.#sealed = true;
    return this;
  }
}
