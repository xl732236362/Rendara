import {
  type BackgroundJobStatus,
  type BackgroundJobType,
  backgroundJobStatusSchema,
  backgroundJobTypeSchema,
  createImageJobRequestSchema,
  createVideoJobRequestSchema,
  generatedAssetAttachmentListResponseSchema,
  generatedAssetAttachmentStatusResponseSchema,
  jobListResponseSchema,
  jobResponseSchema,
  retryGeneratedAssetAttachmentRequestSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { GeneratedAssetAttachmentRecovery } from "../application/canvas/attach-generated-asset.js";
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
const attachmentStatusQuerySchema = z
  .object({ canvasId: z.string().uuid() })
  .strict();
const attachmentListQuerySchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();

export async function registerJobRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    cancelGeneration?: CancelGeneration;
    generatedAssetAttachments?: GeneratedAssetAttachmentRecovery;
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

  app.get("/api/jobs/:jobId/attachment", async (request, reply) => {
    const { user, principal } = await authenticatedPrincipal(
      request,
      reply,
      options,
    );
    if (!user) return principal;
    const { jobId } = parseStringParams(request.params, ["jobId"]);
    const query = parseRequest(attachmentStatusQuerySchema, request.query);
    const recovery = requireAttachmentRecovery(
      options.generatedAssetAttachments,
    );
    const attachment = await recovery.getStatus(principal, {
      jobId,
      canvasId: query.canvasId,
    });
    return reply
      .code(200)
      .send(generatedAssetAttachmentStatusResponseSchema.parse({ attachment }));
  });

  app.get(
    "/api/canvases/:canvasId/generated-asset-attachments",
    async (request, reply) => {
      const { user, principal } = await authenticatedPrincipal(
        request,
        reply,
        options,
      );
      if (!user) return principal;
      const { canvasId } = parseStringParams(request.params, ["canvasId"]);
      const query = parseRequest(attachmentListQuerySchema, request.query);
      const recovery = requireAttachmentRecovery(
        options.generatedAssetAttachments,
      );
      const attachments = await recovery.listOutstanding(principal, {
        canvasId,
        sessionId: query.sessionId,
      });
      return reply
        .code(200)
        .send(
          generatedAssetAttachmentListResponseSchema.parse({ attachments }),
        );
    },
  );

  app.post("/api/jobs/:jobId/attachment/retry", async (request, reply) => {
    const { user, principal } = await authenticatedPrincipal(
      request,
      reply,
      options,
    );
    if (!user) return principal;
    const { jobId } = parseStringParams(request.params, ["jobId"]);
    const body = parseRequest(
      retryGeneratedAssetAttachmentRequestSchema,
      request.body,
    );
    const recovery = requireAttachmentRecovery(
      options.generatedAssetAttachments,
    );
    const attachment = await recovery.retry(principal, {
      jobId,
      canvasId: body.canvasId,
    });
    return reply
      .code(200)
      .send(generatedAssetAttachmentStatusResponseSchema.parse({ attachment }));
  });
}

function requireAttachmentRecovery(value?: GeneratedAssetAttachmentRecovery) {
  if (!value)
    throw new Error("Generated asset attachment recovery is unavailable");
  return value;
}

async function authenticatedPrincipal(
  request: Parameters<RequestAuthenticator["authenticate"]>[0],
  reply: FastifyReply,
  options: {
    auth: RequestAuthenticator;
    viewerService: ViewerService;
  },
) {
  const user = await options.auth.authenticate(request);
  if (!user) return { user: null, principal: sendUnauthenticated(reply) };
  const viewer = await options.viewerService.ensureViewer(user);
  return {
    user,
    principal: {
      userId: user.id,
      workspaceId: viewer.workspace.id,
      accessToken: user.accessToken,
    },
  };
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
