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
  isAttachmentInfrastructureReady?: () => boolean;
}): Pick<
  GenerationApplicationPorts,
  "jobs" | "cancellation" | "attachmentIntents"
> {
  return {
    jobs: {
      async submit(command) {
        const { principal, ...input } = command;
        const outcome = await options.jobService.submitJob(
          options.toAuthenticatedUser(principal),
          input,
        );
        if (!outcome.replayed && outcome.job.status !== "queued") {
          throw invalidLegacyOutcome();
        }
        return {
          id: outcome.job.id,
          status: outcome.job.status,
          replayed: outcome.replayed,
        };
      },
    },
    cancellation: {
      async cancel(principal, jobId) {
        const job = await options.jobService.cancelJob(
          options.toAuthenticatedUser(principal),
          jobId,
        );
        if (job.status === "cancel_requested") {
          return { id: job.id, status: "canceling" };
        }
        if (job.status === "canceled")
          return { id: job.id, status: "canceled" };
        throw invalidLegacyOutcome();
      },
    },
    attachmentIntents: {
      isReady: () => options.isAttachmentInfrastructureReady?.() === true,
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
