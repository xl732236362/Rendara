import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorEnvelopeSchema } from "@loomic/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { CanvasServiceError } from "../features/canvas/canvas-service.js";
import { ChatServiceError } from "../features/chat/chat-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import { PaymentServiceError } from "../features/payments/payment-service.js";
import { ProjectServiceError } from "../features/projects/project-service.js";
import { registerCanvasRoutes } from "./canvases.js";
import { registerChatRoutes } from "./chat.js";
import { registerCreditRoutes } from "./credits.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerJobRoutes } from "./jobs.js";
import { registerPaymentRoutes } from "./payments.js";
import { registerProjectRoutes } from "./projects.js";

const httpDirectory = dirname(fileURLToPath(import.meta.url));

describe("route error migration", () => {
  it.each([
    [
      "projects",
      registerProjectFailure,
      "/api/projects/missing",
      "project_not_found",
      404,
    ],
    [
      "canvases",
      registerCanvasFailure,
      "/api/canvases/missing",
      "canvas_not_found",
      404,
    ],
    [
      "chat",
      registerChatFailure,
      "/api/canvases/canvas-1/sessions",
      "session_not_found",
      404,
    ],
    ["jobs", registerJobFailure, "/api/jobs/missing", "job_not_found", 404],
    [
      "credits",
      registerCreditFailure,
      "/api/credits",
      "insufficient_credits",
      402,
    ],
    [
      "payments",
      registerPaymentFailure,
      "/api/payments/subscription",
      "subscription_not_found",
      404,
    ],
  ] as const)(
    "%s route preserves service status and code",
    async (_domain, register, url, code, statusCode) => {
      const app = Fastify({ logger: false });
      registerErrorHandler(app);
      await register(app);
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ error: { code } });
      expect(() => errorEnvelopeSchema.parse(response.json())).not.toThrow();
      await app.close();
    },
  );

  it("routes do not construct canonical error responses locally", async () => {
    const routeFiles = [
      "brand-kits.ts",
      "canvases.ts",
      "chat.ts",
      "credits.ts",
      "fonts.ts",
      "generate.ts",
      "image-proxy.ts",
      "image-models.ts",
      "jobs.ts",
      "payments.ts",
      "payments-webhook.ts",
      "projects.ts",
      "runs.ts",
      "settings.ts",
      "skills-marketplace.ts",
      "skills.ts",
      "uploads.ts",
      "video-models.ts",
      "viewer.ts",
    ];

    for (const file of routeFiles) {
      const source = await readFile(join(httpDirectory, file), "utf8");
      expect(source, file).not.toMatch(/function\s+isZodError/);
      expect(source, file).not.toMatch(/error\.name\s*===\s*["']ZodError["']/);
      expect(source, file).not.toContain(
        "applicationErrorResponseSchema.parse",
      );
      expect(source, file).not.toContain(
        "unauthenticatedErrorResponseSchema.parse",
      );
      expect(source, file).not.toMatch(/send\(\s*raiseBoundaryError\(/s);
      expect(source, file).not.toMatch(/request\.(body|query|params)\s+as\s+/);
    }
  });

  it("pure route adapters do not wrap handlers in broad catches", async () => {
    for (const file of [
      "brand-kits.ts",
      "canvases.ts",
      "chat.ts",
      "credits.ts",
      "payments.ts",
      "projects.ts",
      "settings.ts",
      "skills.ts",
      "skills-marketplace.ts",
      "uploads.ts",
    ]) {
      const source = await readFile(join(httpDirectory, file), "utf8");
      expect(source, file).not.toMatch(/\bcatch\s*(?:\(|\{)/);
    }
  });

  it("a representative canvas request uses the canonical request envelope", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await registerCanvasRoutes(app, {
      auth: { authenticate: async () => user },
      canvasService: {
        getCanvas: async () => {
          throw new Error("unused");
        },
        saveCanvasContent: async () => ({ revision: 1 }),
      },
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/canvases/canvas-1",
      payload: { content: "not-a-canvas" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request", message: "Request validation failed" },
    });
    expect(() => errorEnvelopeSchema.parse(response.json())).not.toThrow();
    await app.close();
  });

  it("preserves a representative service status and code", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await registerCanvasRoutes(app, {
      auth: { authenticate: async () => user },
      canvasService: {
        getCanvas: async () => {
          throw new CanvasServiceError(
            "canvas_not_found",
            "Canvas not found",
            404,
          );
        },
        saveCanvasContent: async () => ({ revision: 1 }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/canvases/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "canvas_not_found", message: "Canvas not found." },
    });
    await app.close();
  });

  it("keeps a response-schema failure private", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await registerCanvasRoutes(app, {
      auth: { authenticate: async () => user },
      canvasService: {
        getCanvas: async () => ({ secret: "response-secret" }) as never,
        saveCanvasContent: async () => {
          throw new Error("database-secret");
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/canvases/canvas-1",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "application_error",
        message: "An unexpected error occurred",
      },
    });
    expect(response.body).not.toContain("response-secret");
    await app.close();
  });

  it("keeps an unknown service failure private", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await registerCanvasRoutes(app, {
      auth: { authenticate: async () => user },
      canvasService: {
        getCanvas: async () => {
          throw new Error("database-secret");
        },
        saveCanvasContent: async () => ({ revision: 1 }),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/canvases/canvas-1",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "application_error",
        message: "An unexpected error occurred",
      },
    });
    expect(response.body).not.toContain("database-secret");
    await app.close();
  });
});

async function registerProjectFailure(app: ReturnType<typeof Fastify>) {
  await registerProjectRoutes(app, {
    auth,
    projectService: {
      getProject: async () => {
        throw new ProjectServiceError("project_not_found", "missing", 404);
      },
    } as never,
  });
}
async function registerCanvasFailure(app: ReturnType<typeof Fastify>) {
  await registerCanvasRoutes(app, {
    auth,
    canvasService: {
      getCanvas: async () => {
        throw new CanvasServiceError("canvas_not_found", "missing", 404);
      },
      saveCanvasContent: async () => ({ revision: 1 }),
    },
  });
}
async function registerChatFailure(app: ReturnType<typeof Fastify>) {
  await registerChatRoutes(app, {
    auth,
    chatService: {
      listSessions: async () => {
        throw new ChatServiceError("session_not_found", "missing", 404);
      },
    } as never,
  });
}
async function registerJobFailure(app: ReturnType<typeof Fastify>) {
  await registerJobRoutes(app, {
    auth,
    jobService: {
      getJob: async () => {
        throw new JobServiceError("job_not_found", "missing", 404);
      },
    } as never,
    viewerService: {} as never,
  });
}
async function registerCreditFailure(app: ReturnType<typeof Fastify>) {
  await registerCreditRoutes(app, {
    auth,
    creditService: {
      getBalance: async () => {
        throw new CreditServiceError("insufficient_credits", "missing", 402);
      },
    } as never,
    viewerService: {
      ensureViewer: async () => ({ workspace: { id: "workspace-1" } }),
    } as never,
  });
}
async function registerPaymentFailure(app: ReturnType<typeof Fastify>) {
  await registerPaymentRoutes(app, {
    auth,
    paymentService: {
      getSubscriptionStatus: async () => {
        throw new PaymentServiceError("subscription_not_found", "missing", 404);
      },
    } as never,
    viewerService: {
      ensureViewer: async () => ({ workspace: { id: "workspace-1" } }),
    } as never,
  });
}

const auth = { authenticate: async () => user };

const user = {
  accessToken: "token",
  email: "user@example.com",
  id: "user-1",
  userMetadata: {},
};
