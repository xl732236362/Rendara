import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorEnvelopeSchema } from "@loomic/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { CanvasServiceError } from "../features/canvas/canvas-service.js";
import { registerCanvasRoutes } from "./canvases.js";
import { registerErrorHandler } from "./error-handler.js";

const httpDirectory = dirname(fileURLToPath(import.meta.url));

describe("route error migration", () => {
  it.each([
    ["projects", "project_not_found", 404],
    ["canvases", "canvas_not_found", 404],
    ["chat", "session_not_found", 404],
    ["jobs", "job_not_found", 404],
    ["credits", "insufficient_credits", 402],
    ["skills", "capability_disabled", 403],
    ["payments", "subscription_not_found", 404],
  ] as const)(
    "%s preserves its legacy service status and code",
    async (_domain, code, statusCode) => {
      const app = Fastify({ logger: false });
      registerErrorHandler(app);
      app.get("/failure", async () => {
        throw Object.assign(new Error(`${_domain} rejected`), {
          code,
          statusCode,
        });
      });

      const response = await app.inject({ method: "GET", url: "/failure" });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({
        error: { code, message: `${_domain} rejected` },
      });
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
      "generate.ts",
      "jobs.ts",
      "payments.ts",
      "projects.ts",
      "runs.ts",
      "settings.ts",
      "skills-marketplace.ts",
      "skills.ts",
      "uploads.ts",
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
        saveCanvasContent: async () => undefined,
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
        saveCanvasContent: async () => undefined,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/canvases/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "canvas_not_found", message: "Canvas not found" },
    });
    await app.close();
  });

  it("keeps representative response-schema and unknown failures private", async () => {
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
});

const user = {
  accessToken: "token",
  email: "user@example.com",
  id: "user-1",
  userMetadata: {},
};
