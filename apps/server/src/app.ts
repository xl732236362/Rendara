import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { createApplyCanvasOperations } from "./application/canvas/apply-canvas-operations.js";
import { createAttachGeneratedAsset } from "./application/canvas/attach-generated-asset.js";
import { createCancelGeneration } from "./application/generation/cancel-generation.js";
import { createReferenceAssetAuthorizationPort } from "./application/generation/reference-assets.js";
import { createSubmitGeneration } from "./application/generation/submit-generation.js";
import type { UseCases } from "./application/use-cases.js";
import { createDomainEventPublisher } from "./events/domain-event-publisher.js";
import { startOutboxDispatcher } from "./events/outbox-dispatcher.js";

import {
  type BuiltinSkillCatalog,
  loadRepositoryBuiltinSkillCatalog,
} from "./agent/builtin-skills/catalog.js";
import {
  PRODUCTION_AGENT_CAPABILITIES,
  createAgentAuthority,
} from "./agent/capabilities.js";
import type { LoomicAgentFactory } from "./agent/loomic-agent.js";
import {
  type AgentPersistenceService,
  createAgentPersistenceService,
} from "./agent/persistence/index.js";
import { createAgentRunService } from "./agent/runtime.js";
import {
  type AcceptAgentRun,
  createAcceptAgentRun,
} from "./application/agent/accept-agent-run.js";
import {
  type ServerEnv,
  loadServerEnv,
  resolveDefaultAgentModel,
} from "./config/env.js";
import {
  type AgentExecutionRepository,
  createAgentExecutionRepository,
} from "./features/agent-runs/agent-execution-repository.js";
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
  createCanvasAuthorizationPort,
  createCanvasServiceOperationPort,
} from "./features/canvas/canvas-operation-application-adapter.js";
import {
  type CanvasService,
  createCanvasService,
} from "./features/canvas/canvas-service.js";
import { createGeneratedAssetPort } from "./features/canvas/generated-asset-application-adapter.js";
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
import { createJobServiceGenerationPorts } from "./features/jobs/generation-application-adapter.js";
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
import type { ProviderRegistry } from "./generation/providers/registry.js";
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
  acceptAgentRun?: AcceptAgentRun;
  agentExecutionRepository?: AgentExecutionRepository;
  agentFactory?: LoomicAgentFactory;
  agentModel?: BaseLanguageModel | string;
  agentPersistenceService?: AgentPersistenceService;
  agentRunMetadataService?: AgentRunMetadataService;
  builtinSkillCatalogLoader?: () => Promise<BuiltinSkillCatalog>;
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
  providerRegistry?: ProviderRegistry;
  resourceAuthorization?: ResourceAuthorization;
  settingsService?: SettingsService;
  threadService?: ThreadService;
  viewerService?: ViewerService;
  useCases?: Readonly<UseCases>;
  startOutboxDispatcher?: boolean;
};

const appUseCases = new WeakMap<FastifyInstance, Readonly<UseCases>>();
const appBuiltinSkillCatalogs = new WeakMap<
  FastifyInstance,
  BuiltinSkillCatalog
>();

/** Read-only composition diagnostics for tests and process-level integrations. */
export function getAppUseCases(app: FastifyInstance): Readonly<UseCases> {
  const useCases = appUseCases.get(app);
  if (!useCases) throw new Error("Application use cases are not composed.");
  return useCases;
}

export function getAppBuiltinSkillCatalog(app: FastifyInstance) {
  const catalog = appBuiltinSkillCatalogs.get(app);
  if (!catalog) throw new Error("Built-in Skill catalog is not loaded.");
  return catalog;
}

function snapshotUseCases(candidate: Readonly<UseCases>): Readonly<UseCases> {
  const canvas = candidate?.canvas;
  const generation = candidate?.generation;
  if (
    !canvas ||
    typeof canvas.applyOperations !== "function" ||
    typeof canvas.attachGeneratedAsset !== "function" ||
    (generation !== undefined &&
      (typeof generation.cancel !== "function" ||
        typeof generation.submit !== "function"))
  ) {
    throw new TypeError("Invalid injected useCases shape.");
  }
  return Object.freeze({
    canvas: Object.freeze({
      applyOperations: canvas.applyOperations,
      attachGeneratedAsset: canvas.attachGeneratedAsset,
    }),
    ...(generation
      ? {
          generation: Object.freeze({
            cancel: generation.cancel,
            submit: generation.submit,
          }),
        }
      : {}),
  });
}

export function buildAppFromEnv(
  env: ServerEnv,
  options: Omit<BuildAppOptions, "env"> = {},
): FastifyInstance {
  // Validate caller-owned application boundaries before registering any async
  // plugins so a malformed composition cannot leave partially started work.
  const injectedUseCases = options.useCases
    ? snapshotUseCases(options.useCases)
    : undefined;
  // Register generation providers (shared with worker.ts)
  const providerRegistry = (
    options.providerRegistry ?? registerAllProviders(env)
  ).seal();

  const app = Fastify({
    logger: { level: "info" },
  });
  const loadCatalog =
    options.builtinSkillCatalogLoader ?? loadRepositoryBuiltinSkillCatalog;
  app.addHook("onReady", async () => {
    const catalog = await loadCatalog();
    appBuiltinSkillCatalogs.set(app, catalog);
    app.log.info(
      {
        event: "builtin_skill_catalog_loaded",
        digest: catalog.digest,
        skillNames: catalog.list().map((skill) => skill.name),
      },
      "Built-in Skill catalog loaded",
    );
  });
  registerErrorHandler(app);
  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });
  void app.register(async (instance) => {
    await instance.register(websocket);
    await registerWsRoute(instance, {
      acceptAgentRun,
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
  const agentExecutionRepository =
    options.agentExecutionRepository ??
    createAgentExecutionRepository({ getAdminClient });
  const resolveAgentCanvasScope = async (
    principal: { userId: string; accessToken?: string },
    canvasId: string,
  ) => {
    if (!principal.accessToken) throw new Error("canvas_access_denied");
    const client = createUserClient(principal.accessToken);
    const { data, error } = await client
      .from("canvases")
      .select("id, project_id, projects!inner(workspace_id)")
      .eq("id", canvasId)
      .maybeSingle();
    const row = data as unknown as {
      id?: string;
      project_id?: string;
      projects?: { workspace_id?: string };
    } | null;
    if (
      error ||
      row?.id !== canvasId ||
      !row.project_id ||
      !row.projects?.workspace_id
    ) {
      throw new Error("canvas_access_denied");
    }
    return {
      canvasId,
      projectId: row.project_id,
      workspaceId: row.projects.workspace_id,
    };
  };
  const acceptAgentRun =
    options.acceptAgentRun ??
    createAcceptAgentRun({
      catalog: {
        get digest() {
          return getAppBuiltinSkillCatalog(app).digest;
        },
        list: () => getAppBuiltinSkillCatalog(app).list(),
      },
      repository: agentExecutionRepository,
      onAccepted: (event) =>
        app.log.info(
          { event: "agent_run_accepted", ...event },
          "Agent run acceptance persisted",
        ),
      resolveAuthority: () =>
        createAgentAuthority(PRODUCTION_AGENT_CAPABILITIES),
      resolveScope: resolveAgentCanvasScope,
      requireSessionScope: async (principal, sessionId) => {
        if (!principal.accessToken) throw new Error("canvas_access_denied");
        const client = createUserClient(principal.accessToken);
        const { data, error } = await client
          .from("chat_sessions")
          .select("canvas_id")
          .eq("id", sessionId)
          .maybeSingle();
        if (error || !data?.canvas_id) throw new Error("canvas_access_denied");
        return resolveAgentCanvasScope(principal, data.canvas_id);
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
    options.canvasService ??
    createCanvasService({ createUserClient, getAdminClient });
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
    (pgmq ? createJobService({ createUserClient, getAdminClient }) : undefined);
  const creditService =
    options.creditService ?? createCreditService({ getAdminClient });
  const tierGuard = options.tierGuard ?? createTierGuard({ getAdminClient });
  const toAuthenticatedUser = (principal: {
    userId: string;
    accessToken?: string;
  }) => ({
    id: principal.userId,
    accessToken: principal.accessToken ?? "",
    email: "",
    userMetadata: {},
  });
  const logger = {
    info: (message: string, context: Record<string, unknown>) =>
      app.log.info(context, message),
    warn: (message: string, context: Record<string, unknown>) =>
      app.log.warn(context, message),
    error: (message: string, context: Record<string, unknown>) =>
      app.log.error(context, message),
  };
  const generationPorts = jobService
    ? createJobServiceGenerationPorts({ jobService, toAuthenticatedUser })
    : undefined;
  const useCases: Readonly<UseCases> =
    injectedUseCases ??
    Object.freeze({
      canvas: Object.freeze({
        applyOperations: createApplyCanvasOperations({
          logger,
          ports: {
            authorization: createCanvasAuthorizationPort({
              authorization: resourceAuthorization,
              toAuthenticatedUser,
            }),
            operations: createCanvasServiceOperationPort({
              canvasService,
              toAuthenticatedUser,
            }),
          },
        }),
        attachGeneratedAsset: createAttachGeneratedAsset({
          authorization: createCanvasAuthorizationPort({
            authorization: resourceAuthorization,
            toAuthenticatedUser,
          }),
          assets: createGeneratedAssetPort({
            createUserClient,
            getAdminClient,
          }),
        }),
      }),
      ...(generationPorts
        ? {
            generation: Object.freeze({
              submit: createSubmitGeneration({
                logger,
                ports: {
                  ...generationPorts,
                  referenceAssets: createReferenceAssetAuthorizationPort({
                    createUserClient,
                  }),
                  models: {
                    resolveModel(type, requestedModel) {
                      const fallback =
                        type === "image_generation"
                          ? "black-forest-labs/flux-kontext-pro"
                          : "wan-video/wan-2.6";
                      const model = requestedModel ?? fallback;
                      if (type === "image_generation")
                        providerRegistry.resolveImageProviderName(model);
                      else providerRegistry.resolveVideoProviderName(model);
                      return model;
                    },
                  },
                  tiers: {
                    async getPlan(workspaceId) {
                      return (await creditService.getSubscription(workspaceId))
                        .plan;
                    },
                    authorizeModel: (plan, model) =>
                      tierGuard.checkModelAccess(plan, model),
                    authorizeMedia(plan, request) {
                      if (request.type === "image_generation") {
                        tierGuard.checkResolution(
                          plan,
                          request.quality ?? "hd",
                        );
                      } else if (
                        request.resolution === "720p" ||
                        request.resolution === "1080p" ||
                        request.resolution === "4k"
                      ) {
                        tierGuard.checkVideoResolution(
                          plan,
                          request.resolution,
                        );
                      }
                    },
                    authorizeConcurrency: (workspaceId, plan) =>
                      tierGuard.checkConcurrency(workspaceId, plan),
                    calculateCreditCost(model, request) {
                      return tierGuard.calculateCreditCost(
                        model,
                        request.type,
                        request.type === "image_generation"
                          ? { quality: request.quality ?? "hd" }
                          : {
                              ...(request.duration !== undefined
                                ? { duration: request.duration }
                                : {}),
                              ...(request.resolution === "720p" ||
                              request.resolution === "1080p" ||
                              request.resolution === "4k"
                                ? { resolution: request.resolution }
                                : {}),
                            },
                      );
                    },
                  },
                  credits: {
                    getBalance: (workspaceId) =>
                      creditService.getBalance(workspaceId),
                  },
                },
              }),
              cancel: createCancelGeneration({
                jobs: generationPorts.cancellation,
                logger,
              }),
            }),
          }
        : {}),
    });
  appUseCases.set(app, useCases);

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
  const publishDomainEvent = createDomainEventPublisher({
    rememberCanvasEvent: (canvasId, eventId, event) =>
      eventBuffer.pushDomainEvent(canvasId, eventId, event),
    pushCanvas: (canvasId, event) =>
      connectionManager.pushToCanvas(canvasId, event),
    sendToUser: (userId, message) =>
      connectionManager.sendToUser(userId, message),
  });
  const eventBufferCleanupTimer = setInterval(
    () => eventBuffer.cleanup(),
    5 * 60 * 1000,
  );
  eventBufferCleanupTimer.unref?.();
  const outboxAbort = new AbortController();
  const shouldStartOutbox =
    options.startOutboxDispatcher ?? process.env.NODE_ENV !== "test";
  const outboxTask = shouldStartOutbox
    ? startOutboxDispatcher({
        workerId: `api-${process.pid}`,
        batchSize: 25,
        idleDelayMs: 1_000,
        signal: outboxAbort.signal,
        claim: async (limit, workerId) => {
          const { data, error } = await callAdminRpc(
            getAdminClient(),
            "claim_domain_outbox",
            { p_limit: limit, p_worker_id: workerId },
          );
          if (error) throw error;
          return data ?? [];
        },
        publish: publishDomainEvent,
        ack: async (eventId, workerId) => {
          const { error } = await callAdminRpc(
            getAdminClient(),
            "ack_domain_outbox",
            { p_event_id: eventId, p_worker_id: workerId },
          );
          if (error) throw error;
        },
        fail: async (eventId, workerId, errorCode) => {
          const { error } = await callAdminRpc(
            getAdminClient(),
            "fail_domain_outbox",
            {
              p_event_id: eventId,
              p_worker_id: workerId,
              p_error_code: errorCode,
            },
          );
          if (error) throw error;
        },
        onError: (error) =>
          app.log.error({ err: error }, "domain outbox dispatcher failed"),
      })
    : Promise.resolve();
  app.addHook("onClose", async () => {
    outboxAbort.abort();
    await outboxTask;
    clearInterval(eventBufferCleanupTimer);
    eventBuffer.dispose();
    connectionManager.dispose();
  });
  const agentRuns = createAgentRunService({
    agentExecutionRepository,
    applyCanvasOperations: useCases.canvas.applyOperations,
    attachGeneratedAsset: useCases.canvas.attachGeneratedAsset,
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
    providerRegistry,
    builtinSkillCatalog: {
      get digest() {
        return getAppBuiltinSkillCatalog(app).digest;
      },
      list: () => getAppBuiltinSkillCatalog(app).list(),
      get: (name) => getAppBuiltinSkillCatalog(app).get(name),
    },
    ...(jobService ? { jobService } : {}),
    creditService,
    tierGuard,
    ...(useCases.generation
      ? { submitGeneration: useCases.generation.submit }
      : {}),
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
    acceptAgentRun,
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
  void registerImageModelRoutes(app, {
    auth,
    creditService,
    providerRegistry,
    viewerService,
  });
  void registerVideoModelRoutes(app, {
    auth,
    creditService,
    providerRegistry,
    viewerService,
  });
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
    providerRegistry,
    uploadService,
    viewerService,
    ...(useCases.generation
      ? { submitGeneration: useCases.generation.submit }
      : {}),
    ...(jobService ? { jobService } : {}),
    ...(tierGuard ? { tierGuard } : {}),
  });
  void registerCreditRoutes(app, { auth, creditService, viewerService });
  if (jobService) {
    void registerJobRoutes(app, {
      auth,
      jobService,
      ...(useCases.generation
        ? {
            cancelGeneration: useCases.generation.cancel,
            submitGeneration: useCases.generation.submit,
          }
        : {}),
      viewerService,
    });
  }

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

async function callAdminRpc(
  client: ReturnType<typeof createAdminSupabaseClient>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown | null }> {
  return (
    client as unknown as {
      rpc(
        name: string,
        args: Record<string, unknown>,
      ): Promise<{ data: unknown; error: unknown | null }>;
    }
  ).rpc(name, args);
}

export function buildAppWithOverrides(
  options: BuildAppOptions = {},
): FastifyInstance {
  const env = loadServerEnv(options.env);
  return buildAppFromEnv(env, options);
}

/** @deprecated Production composition must parse once and use buildAppFromEnv. */
export const buildApp = buildAppWithOverrides;

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
