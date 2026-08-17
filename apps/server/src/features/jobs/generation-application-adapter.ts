import type {
  GenerationApplicationPorts,
  GenerationPrincipal,
} from "../../application/generation/ports.js";
import { AppError } from "../../errors/app-error.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import type { JobService } from "./job-service.js";

export function createJobServiceGenerationPorts(options: {
  jobService: JobService;
  toAuthenticatedUser(principal: GenerationPrincipal): AuthenticatedUser;
}): Pick<GenerationApplicationPorts, "jobs" | "cancellation"> {
  return {
    jobs: {
      async create(command) {
        const { principal, ...input } = command;
        const job = await options.jobService.createJob(
          options.toAuthenticatedUser(principal),
          input,
        );
        if (job.status !== "queued") throw invalidLegacyOutcome();
        return { id: job.id, status: "queued" };
      },
      attachCredits(jobId, creditsCost, transactionId) {
        return options.jobService.setCreditsInfo(
          jobId,
          creditsCost,
          transactionId,
        );
      },
    },
    cancellation: {
      async cancel(principal, jobId) {
        const job = await options.jobService.cancelJob(
          options.toAuthenticatedUser(principal),
          jobId,
        );
        if (job.status !== "canceled") throw invalidLegacyOutcome();
        return { id: job.id, status: "canceled" };
      },
    },
  };
}

function invalidLegacyOutcome(): AppError {
  return new AppError({
    code: "application_error",
    statusCode: 500,
    message: "Job service returned an invalid generation outcome.",
  });
}
