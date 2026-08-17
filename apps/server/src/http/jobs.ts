import {
  type BackgroundJobStatus,
  type BackgroundJobType,
  backgroundJobStatusSchema,
  backgroundJobTypeSchema,
  createImageJobRequestSchema,
  createVideoJobRequestSchema,
  jobListResponseSchema,
  jobResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { CancelGeneration } from "../application/generation/cancel-generation.js";
import type { SubmitGeneration } from "../application/generation/submit-generation.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  parseRequest,
  parseStringParams,
  raiseBoundaryError,
} from "./route-errors.js";

const jobListQuerySchema = z.object({
  status: backgroundJobStatusSchema.optional(),
  job_type: backgroundJobTypeSchema.optional(),
});

export async function registerJobRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    cancelGeneration?: CancelGeneration;
    jobService: Pick<JobService, "getJob" | "listJobs">;
    submitGeneration?: SubmitGeneration;
    viewerService: ViewerService;
  },
) {
  app.post("/api/jobs/image-generation", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    const payload = parseRequest(createImageJobRequestSchema, request.body);
    const viewer = await options.viewerService.ensureViewer(user);
    const principal = {
      userId: user.id,
      workspaceId: viewer.workspace.id,
      accessToken: user.accessToken,
    };
    if (!options.submitGeneration)
      throw new Error("Generation submission is unavailable");
    const submitted = await options.submitGeneration(principal, {
      type: "image_generation",
      ...payload,
    });
    const job = await options.jobService.getJob(user, submitted.jobId);
    return reply.code(201).send(jobResponseSchema.parse({ job }));
  });

  app.post("/api/jobs/video-generation", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    const payload = parseRequest(createVideoJobRequestSchema, request.body);
    const viewer = await options.viewerService.ensureViewer(user);
    const principal = {
      userId: user.id,
      workspaceId: viewer.workspace.id,
      accessToken: user.accessToken,
    };
    if (!options.submitGeneration)
      throw new Error("Generation submission is unavailable");
    const submitted = await options.submitGeneration(principal, {
      type: "video_generation",
      ...payload,
    });
    const job = await options.jobService.getJob(user, submitted.jobId);
    return reply.code(201).send(jobResponseSchema.parse({ job }));
  });

  app.get("/api/jobs/:jobId", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    const { jobId } = parseStringParams(request.params, ["jobId"]);
    const job = await options.jobService.getJob(user, jobId);
    return reply.code(200).send(jobResponseSchema.parse({ job }));
  });

  app.get("/api/jobs", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    const query = parseRequest(jobListQuerySchema, request.query);
    const filters: {
      status?: BackgroundJobStatus;
      jobType?: BackgroundJobType;
    } = {};
    if (query.status) filters.status = query.status;
    if (query.job_type) filters.jobType = query.job_type;
    const jobs = await options.jobService.listJobs(user, filters);
    return reply.code(200).send(jobListResponseSchema.parse({ jobs }));
  });

  app.post("/api/jobs/:jobId/cancel", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    const { jobId } = parseStringParams(request.params, ["jobId"]);
    const viewer = await options.viewerService.ensureViewer(user);
    if (!options.cancelGeneration)
      throw new Error("Generation cancellation is unavailable");
    await options.cancelGeneration(
      {
        userId: user.id,
        workspaceId: viewer.workspace.id,
        accessToken: user.accessToken,
      },
      { jobId },
    );
    const job = await options.jobService.getJob(user, jobId);
    return reply.code(200).send(jobResponseSchema.parse({ job }));
  });
}

function sendUnauthenticated(_reply: FastifyReply) {
  return raiseBoundaryError(
    {
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    },
    401,
  );
}
