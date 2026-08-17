import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { LoomicAgentFactory } from "./agent/deep-agent.js";
import {
  type AgentPersistenceService,
  createAgentPersistenceService,
} from "./agent/persistence/index.js";
import { createAgentRunService } from "./agent/runtime.js";
import {
  type ServerEnv,
  loadServerEnv,
  resolveDefaultAgentModel,
} from "./config/env.js";
import {
  type AgentRunMetadataService,
  createAgentRunMetadataService,
} from "./features/agent-runs/agent-run-service.js";
import {
  type ViewerService,
  createViewerService,
} from "./features/bootstrap/ensure-user-foundation.js";
import {
  type BrandKitService,
  createBrandKitService,
} from "./features/brand-kit/brand-kit-service.js";
import {
  type CanvasService,
  createCanvasService,
} from "./features/canvas/canvas-service.js";
import {
  type ChatService,
  createChatService,
} from "./features/chat/chat-service.js";
import {
  type ThreadService,
  createThreadService,
} from "./features/chat/thread-service.js";
import {
  type CreditService,
  createCreditService,
} from "./features/credits/credit-service.js";
import {
  type TierGuard,
  createTierGuard,
} from "./features/credits/tier-guard.js";
import {
  type JobService,
  createJobService,
} from "./features/jobs/job-service.js";
import { createLemonSqueezyClient } from "./features/payments/lemon-squeezy-client.js";
import {
  type PaymentService,
  buildVariantMap,
  createPaymentService,
} from "./features/payments/payment-service.js";
import {
  type ProjectService,
  createProjectService,
} from "./features/projects/project-service.js";
import {
  type SettingsService,
  createSettingsService,
} from "./features/settings/settings-service.js";
import {
  type UploadService,
  createUploadService,
} from "./features/uploads/upload-service.js";
import { registerAllProviders } from "./generation/providers/register-all.js";
import { registerBrandKitRoutes } from "./http/brand-kits.js";
import { registerCanvasRoutes } from "./http/canvases.js";
import { registerChatRoutes } from "./http/chat.js";
import { registerCreditRoutes } from "./http/credits.js";
import { registerErrorHandler } from "./http/error-handler.js";
import { registerFontsRoutes } from "./http/fonts.js";
import { registerGenerateRoutes } from "./http/generate.js";
import { registerHealthRoutes } from "./http/health.js";
import { registerImageModelRoutes } from "./http/image-models.js";
import { registerImageProxyRoute } from "./http/image-proxy.js";
import { registerJobRoutes } from "./http/jobs.js";
import { registerModelRoutes } from "./http/models.js";
import { registerPaymentWebhookRoute } from "./http/payments-webhook.js";
import { registerPaymentRoutes } from "./http/payments.js";
import { registerProjectRoutes } from "./http/projects.js";
import { registerRunRoutes } from "./http/runs.js";
import { registerSettingsRoutes } from "./http/settings.js";
import { registerMarketplaceRoutes } from "./http/skills-marketplace.js";
import { registerSkillRoutes } from "./http/skills.js";
import { registerUploadRoutes } from "./http/uploads.js";
import { registerVideoModelRoutes } from "./http/video-models.js";
import { registerViewerRoutes } from "./http/viewer.js";
import { createPgmqClient } from "./queue/pgmq-client.js";
import { registerRateLimiting } from "./security/rate-limit.js";
import {
  type ResourceAuthorization,
  createResourceAuthorization,
} from "./security/resource-authorization.js";
import { safeFetch } from "./security/safe-fetch.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import {
  type RequestAuthenticator,
  createSupabaseRequestAuthenticator,
  createUserSupabaseClientFactory,
} from "./supabase/user.js";
import { ConnectionManager } from "./ws/connection-manager.js";
import { CanvasEventBuffer } from "./ws/event-buffer.js";
import { registerWsRoute } from "./ws/handler.js";

export type BuildAppOptions = {
  agentFactory?: LoomicAgentFactory;
  agentModel?: BaseLanguageModel | string;
  agentPersistenceService?: AgentPersistenceService;
  agentRunMetadataService?: AgentRunMetadataService;
  auth?: RequestAuthenticator;
  brandKitService?: BrandKitService;
  canvasService?: CanvasService;
  chatService?: ChatService;
  connectionManager?: ConnectionManager;
  creditService?: CreditService;
  env?: Partial<ServerEnv>;
  jobService?: JobService;
  paymentService?: PaymentService;
  tierGuard?: TierGuard;
  uploadService?: UploadService;
  mockEventDelayMs?: number;
  projectService?: ProjectService;
  resourceAuthorization?: ResourceAuthorization;
  settingsService?: SettingsService;
  threadService?: ThreadService;
  viewerService?: ViewerService;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = loadServerEnv(options.env);

  // Register generation providers (shared with worker.ts)
  registerAllProviders(env);

  const app = Fastify({
    logger: { level: "info" },
  });
  registerErrorHandler(app);
  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });
  void app.register(async (instance) => {
    await instance.register(websocket);
    await registerWsRoute(instance, {
      agentRuns,
      agentRunMetadataService,
      auth,
      chatService,
      connectionManager,
      eventBuffer,
      authorization: resourceAuthorization,
      settingsService,
      threadService,
      viewerService,
    });
  });
  const auth = options.auth ?? createSupabaseRequestAuthenticator(env);
  void registerRateLimiting(app, {
    auth,
    budgets: {
      defaultPerMinute: env.rateLimitDefaultPerMinute,
      generationPerMinute: env.rateLimitGenerationPerMinute,
      imageProxyPerMinute: env.rateLimitImageProxyPerMinute,
      skillImportPerHour: env.rateLimitSkillImportPerHour,
      uploadsPerMinute: env.rateLimitUploadsPerMinute,
    },
  });
  const createUserClient = createUserSupabaseClientFactory(env);
  let adminClient: ReturnType<typeof createAdminSupabaseClient> | undefined;
  const getAdminClient = () => {
    adminClient ??= createAdminSupabaseClient(env);
    return adminClient;
  };
  const resourceAuthorization =
    options.resourceAuthorization ??
    createResourceAuthorization({
      createUserClient,
      async findRunSessionId(runId) {
        const { data, error } = await getAdminClient()
          .from("agent_runs")
          .select("session_id")
          .eq("id", runId)
          .single();
        return error || !data ? null : data.session_id;
      },
    });
  const viewerService =
    options.viewerService ?? createViewerService({ getAdminClient });
  const projectService =
    options.projectService ??
    createProjectService({ createUserClient, viewerService });
  const brandKitService =
    options.brandKitService ?? createBrandKitService({ createUserClient });
  const canvasService =
    options.canvasService ?? createCanvasService({ createUserClient });
  const threadService =
    options.threadService ?? createThreadService({ createUserClient });
  const chatService =
    options.chatService ??
    createChatService({ createUserClient, threadService });
  const agentRunMetadataService =
    options.agentRunMetadataService ??
    createAgentRunMetadataService({ getAdminClient });
  const agentPersistenceService =
    options.agentPersistenceService ?? createAgentPersistenceService(env);
  const settingsService =
    options.settingsService ??
    createSettingsService({
      createUserClient,
      defaultModel: resolveDefaultAgentModel(env),
    });
  const uploadService =
    options.uploadService ?? createUploadService({ createUserClient });
  const pgmq = env.supabaseDbUrl
    ? createPgmqClient(env.supabaseDbUrl)
    : undefined;
  const jobService =
    options.jobService ??
    (pgmq
      ? createJobService({ createUserClient, getAdminClient, pgmq })
      : undefined);
  const creditService =
    options.creditService ?? createCreditService({ getAdminClient });
  const tierGuard = options.tierGuard ?? createTierGuard({ getAdminClient });

  // Payment service — only created when Lemon Squeezy is configured
  let paymentService: PaymentService | undefined = options.paymentService;
  if (!paymentService && env.lemonSqueezyApiKey && env.lemonSqueezyStoreId) {
    const lsClient = createLemonSqueezyClient({
      apiKey: env.lemonSqueezyApiKey,
      storeId: env.lemonSqueezyStoreId,
    });
    paymentService = createPaymentService({
      lemonSqueezy: lsClient,
      getAdminClient,
      variantMap: buildVariantMap(env),
      webOrigin: env.webOrigin,
    });
  }

  const connectionManager =
    options.connectionManager ?? new ConnectionManager();
  const eventBuffer = new CanvasEventBuffer();
  setInterval(() => eventBuffer.cleanup(), 5 * 60 * 1000);
  const agentRuns = createAgentRunService({
    agentPersistenceService,
    ...(options.agentFactory ? { agentFactory: options.agentFactory } : {}),
    agentRunMetadataService,
    connectionManager,
    createUserClient,
    ...(options.agentModel ? { model: options.agentModel } : {}),
    ...(options.mockEventDelayMs === undefined
      ? {}
      : { eventDelayMs: options.mockEventDelayMs }),
    env,
    ...(jobService ? { jobService } : {}),
    creditService,
    tierGuard,
    viewerService,
  });

  app.addHook("onRequest", async (request, reply) => {
    const corsResult = evaluateCors(request, env.webOrigin);

    if (!corsResult.allowed) {
      return reply.code(403).send({
        message: "Origin not allowed",
      });
    }

    if (corsResult.allowOrigin) {
      reply.header("access-control-allow-origin", corsResult.allowOrigin);
      reply.header("vary", "Origin");
    }

    if (corsResult.isBrowserRequest) {
      reply.header(
        "access-control-allow-methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
      reply.header(
        "access-control-allow-headers",
        resolveAllowedHeaders(
          request.headers["access-control-request-headers"],
        ),
      );
    }

    if (corsResult.isPreflight) {
      return reply.code(204).send();
    }
  });

  void registerHealthRoutes(app, env);
  void registerFontsRoutes(app, { env });
  const imageAllowedHosts = ["replicate.delivery", "replicate.com"];
  if (env.supabaseUrl) {
    try {
      imageAllowedHosts.push(new URL(env.supabaseUrl).hostname);
    } catch {
      app.log.warn(
        "SUPABASE_URL is invalid; storage images cannot be proxied.",
      );
    }
  }
  void registerImageProxyRoute(app, {
    auth,
    safeFetch: (url) =>
      safeFetch(url, {
        allowedHosts: imageAllowedHosts,
        allowedMimeTypes: [/^image\//i],
        maxBytes: 20 * 1024 * 1024,
        maxRedirects: 3,
        timeoutMs: 15_000,
      }),
  });
  void registerRunRoutes(app, agentRuns, {
    agentRunMetadataService,
    auth,
    authorization: resourceAuthorization,
    settingsService,
    threadService,
    viewerService,
  });
  void registerViewerRoutes(app, {
    auth,
    createUserClient,
    creditService,
    viewerService,
  });
  void registerBrandKitRoutes(app, {
    auth,
    brandKitService,
  });
  void registerProjectRoutes(app, {
    auth,
    projectService,
  });
  void registerCanvasRoutes(app, {
    auth,
    canvasService,
  });
  void registerSettingsRoutes(app, {
    auth,
    settingsService,
    viewerService,
  });
  void registerModelRoutes(app, env);
  void registerImageModelRoutes(app, { auth, creditService, viewerService });
  void registerVideoModelRoutes(app, { auth, creditService, viewerService });
  void registerChatRoutes(app, {
    auth,
    chatService,
  });
  void registerUploadRoutes(app, {
    auth,
    uploadService,
    viewerService,
  });
  void registerGenerateRoutes(app, {
    auth,
    creditService,
    uploadService,
    viewerService,
    ...(jobService ? { jobService } : {}),
    ...(tierGuard ? { tierGuard } : {}),
  });
  void registerCreditRoutes(app, { auth, creditService, viewerService });
  if (jobService) {
    void registerJobRoutes(app, {
      auth,
      creditService,
      jobService,
      tierGuard,
      viewerService,
    });
  }
  void registerSkillRoutes(app, {
    allowExternalSkillImport: env.allowExternalSkillImport,
    auth,
    createUserClient,
    viewerService,
  });
  void registerMarketplaceRoutes(app, {
    auth,
    createUserClient,
    viewerService,
  });

  // Payment routes — only registered when Lemon Squeezy is configured
  if (paymentService) {
    void registerPaymentRoutes(app, { auth, paymentService, viewerService });

    if (env.lemonSqueezyWebhookSecret) {
      // Webhook route is registered in an encapsulated plugin so the custom
      // content-type parser (needed for raw body access) does not leak to
      // other routes.
      void app.register(async (webhookScope) => {
        await registerPaymentWebhookRoute(webhookScope, {
          getAdminClient,
          paymentService: paymentService!,
          webhookSecret: env.lemonSqueezyWebhookSecret!,
        });
      });
    }
  }

  return app;
}

type CorsResult = {
  allowed: boolean;
  allowOrigin: string | null;
  isBrowserRequest: boolean;
  isPreflight: boolean;
};

function evaluateCors(request: FastifyRequest, webOrigin: string): CorsResult {
  const origin = request.headers.origin;
  const isPreflight =
    request.method === "OPTIONS" &&
    typeof request.headers["access-control-request-method"] === "string";

  if (!origin) {
    return {
      allowed: true,
      allowOrigin: null,
      isBrowserRequest: false,
      isPreflight,
    };
  }

  if (origin === webOrigin) {
    return {
      allowed: true,
      allowOrigin: origin,
      isBrowserRequest: true,
      isPreflight,
    };
  }

  if (origin === "null" && isLoopbackHost(request.headers.host)) {
    return {
      allowed: true,
      allowOrigin: origin,
      isBrowserRequest: true,
      isPreflight,
    };
  }

  return {
    allowed: false,
    allowOrigin: null,
    isBrowserRequest: true,
    isPreflight,
  };
}

function resolveAllowedHeaders(requestHeaders: string | undefined) {
  return requestHeaders?.trim() || "Content-Type";
}

function isLoopbackHost(host: string | undefined) {
  if (!host) {
    return false;
  }

  if (host.startsWith("[")) {
    return host.startsWith("[::1]");
  }

  const [hostname] = host.split(":");
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}
