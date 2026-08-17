import { type BoundaryErrorCode, errorEnvelopeSchema } from "@loomic/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import Fastify from "fastify";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { AppError, type AppErrorOptions } from "../errors/app-error.js";
import { parseRequest } from "../errors/request-validation.js";
import { registerErrorHandler } from "./error-handler.js";

describe("Fastify error boundary", () => {
  it("only accepts codes registered by the shared boundary contract", () => {
    expectTypeOf<AppErrorOptions["code"]>().toEqualTypeOf<BoundaryErrorCode>();
  });

  it("maps Zod request parsing failures to a safe canonical envelope", async () => {
    const app = createTestApp();
    app.post("/zod", async (request) => {
      parseRequest(z.object({ name: z.string().min(1) }), request.body);
      return { ok: true };
    });

    const response = await app.inject({
      method: "POST",
      url: "/zod",
      payload: { name: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request validation failed",
        details: {
          issues: [
            {
              code: "too_small",
              message: "Too small: expected string to have >=1 characters",
              path: ["name"],
            },
          ],
        },
      },
    });
    expect(() => errorEnvelopeSchema.parse(response.json())).not.toThrow();
    await app.close();
  });

  it("keeps unmarked internal Zod failures private", async () => {
    const app = createTestApp();
    app.get("/internal-schema", async () => {
      z.object({ providerKey: z.string() }).parse({ providerKey: 42 });
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal-schema",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "application_error",
        message: "An unexpected error occurred",
      },
    });
    expect(response.body).not.toContain("providerKey");
    await app.close();
  });

  it("preserves exposed AppError status, code, message, and safe details", async () => {
    const app = createTestApp();
    app.get("/application", async () => {
      throw new AppError({
        code: "project_not_found",
        statusCode: 404,
        message: "Project not found",
        expose: true,
        details: { projectId: "project-1" },
      });
    });

    const response = await app.inject({ method: "GET", url: "/application" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "project_not_found",
        message: "Project not found",
        details: { projectId: "project-1" },
      },
    });
    expect(() => errorEnvelopeSchema.parse(response.json())).not.toThrow();
    await app.close();
  });

  it("hides unknown internal error messages and request data", async () => {
    const { app, records } = createLoggedTestApp();
    app.post("/unknown", async () => {
      throw Object.assign(
        new Error("database password is hunter2", {
          cause: new Error("provider token=upstream-token"),
        }),
        { code: "DB_FAILURE" },
      );
    });

    const response = await app.inject({
      method: "POST",
      url: "/unknown",
      payload: { prompt: "private prompt", token: "secret-token" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "application_error",
        message: "An unexpected error occurred",
      },
    });
    expect(response.body).not.toContain("hunter2");
    const boundaryLog = records.find(
      (record) => record.fields.event === "http_request_failed",
    );
    expect(boundaryLog?.level).toBe("error");
    expect(boundaryLog?.fields).toMatchObject({
      errorName: "Error",
      errorMessage: expect.any(String),
      errorCode: "DB_FAILURE",
      errorStack: expect.any(String),
      errorCause: {
        errorName: "Error",
        errorMessage: expect.any(String),
      },
      requestId: expect.any(String),
    });
    expect(JSON.stringify(boundaryLog?.fields)).toContain("[REDACTED]");
    expect(JSON.stringify(boundaryLog?.fields)).not.toContain("hunter2");
    expect(JSON.stringify(boundaryLog?.fields)).not.toContain("private prompt");
    expect(JSON.stringify(boundaryLog?.fields)).not.toContain("secret-token");
    await app.close();
  });

  it("classifies a proven client disconnect without reporting a server defect", async () => {
    const { app, records } = createLoggedTestApp();
    app.get("/interrupted", async (request) => {
      Object.defineProperty(request.raw, "aborted", { value: true });
      throw Object.assign(new Error("client disconnected"), {
        code: "ECONNRESET",
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/interrupted",
    });

    expect(response.statusCode).toBe(499);
    expect(response.json()).toEqual({
      error: {
        code: "request_aborted",
        message: "Request was aborted",
      },
    });
    expect(() => errorEnvelopeSchema.parse(response.json())).not.toThrow();
    const boundaryLog = records.find(
      (record) => record.fields.event === "http_request_interrupted",
    );
    expect(boundaryLog?.level).toBe("info");
    expect(
      records.some(
        (record) =>
          record.level === "error" &&
          record.fields.event === "http_request_failed",
      ),
    ).toBe(false);
    await app.close();
  });

  it.each([
    ["AbortError", "ABORT_ERR"],
    ["Error", "ECONNRESET"],
  ])("keeps an unproven upstream %s private", async (name, code) => {
    const app = createTestApp();
    app.get("/upstream-abort", async () => {
      throw Object.assign(new Error("upstream credential secret"), {
        name,
        code,
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/upstream-abort",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "application_error",
        message: "An unexpected error occurred",
      },
    });
    await app.close();
  });

  it("uses explicit AppError provenance for upstream timeouts", async () => {
    const app = createTestApp();
    app.get("/timeout", async () => {
      throw new AppError({
        code: "request_timeout",
        statusCode: 504,
        message: "Request timed out",
        expose: true,
      });
    });

    const response = await app.inject({ method: "GET", url: "/timeout" });

    expect(response.statusCode).toBe(504);
    expect(() => errorEnvelopeSchema.parse(response.json())).not.toThrow();
    await app.close();
  });

  it("rejects AppError values that cannot form a canonical response", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(
      () =>
        new AppError({
          code: "application_error",
          statusCode: 200,
          message: "bad",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new AppError({
          code: "application_error",
          statusCode: 500,
          message: "",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new AppError({
          code: "application_error",
          statusCode: 500,
          message: "bad details",
          expose: true,
          details: circular,
        }),
    ).toThrow(TypeError);
  });

  it("turns invalid circular AppError details into a canonical private 500", async () => {
    const app = createTestApp();
    app.get("/circular-details", async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      throw new AppError({
        code: "application_error",
        statusCode: 500,
        message: "must not escape",
        expose: true,
        details: circular,
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/circular-details",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "application_error",
        message: "An unexpected error occurred",
      },
    });
    expect(() => errorEnvelopeSchema.parse(response.json())).not.toThrow();
    await app.close();
  });

  it("does not send a second response after reply is already sent", async () => {
    const app = createTestApp();
    app.get("/already-sent", async (_request, reply) => {
      reply.code(202).send({ accepted: true });
      throw new Error("late failure");
    });

    const response = await app.inject({ method: "GET", url: "/already-sent" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    await app.close();
  });

  it("normalizes Fastify validation errors through the same envelope", async () => {
    const app = createTestApp();
    app.post(
      "/fastify-validation",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
      async () => ({ ok: true }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/fastify-validation",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_request",
        message: "Request validation failed",
        details: { issues: expect.any(Array) },
      },
    });
    await app.close();
  });

  it("normalizes Fastify JSON parse errors through the same envelope", async () => {
    const app = createTestApp();
    app.post("/json", async () => ({ ok: true }));

    const response = await app.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: '{"name":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request validation failed",
      },
    });
    await app.close();
  });
});

function createTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  return app;
}

type LogRecord = {
  level: string;
  fields: Record<string, unknown>;
};

function createLoggedTestApp(): {
  app: FastifyInstance;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const write = (level: string) => (fields: unknown) => {
    records.push({
      level,
      fields:
        typeof fields === "object" && fields !== null
          ? (fields as Record<string, unknown>)
          : {},
    });
  };
  const logger = {
    level: "info",
    child() {
      return this;
    },
    fatal: write("fatal"),
    error: write("error"),
    warn: write("warn"),
    info: write("info"),
    debug: write("debug"),
    trace: write("trace"),
    silent: write("silent"),
  } as FastifyBaseLogger;
  const app = Fastify({ loggerInstance: logger });
  registerErrorHandler(app);
  return { app, records };
}
