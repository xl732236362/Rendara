import { type BoundaryErrorCode, errorEnvelopeSchema } from "@loomic/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import Fastify from "fastify";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { AppError, type AppErrorOptions } from "../errors/app-error.js";
import { registerErrorHandler } from "./error-handler.js";

describe("Fastify error boundary", () => {
  it("only accepts codes registered by the shared boundary contract", () => {
    expectTypeOf<AppErrorOptions["code"]>().toEqualTypeOf<BoundaryErrorCode>();
  });

  it("maps Zod request parsing failures to a safe canonical envelope", async () => {
    const app = createTestApp();
    app.post("/zod", async (request) => {
      z.object({ name: z.string().min(1) }).parse(request.body);
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
      throw new Error("database password is hunter2");
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
    expect(JSON.stringify(boundaryLog?.fields)).not.toContain("private prompt");
    expect(JSON.stringify(boundaryLog?.fields)).not.toContain("secret-token");
    await app.close();
  });

  it.each([
    ["ABORT_ERR", "request_aborted", 499],
    ["UND_ERR_CONNECT_TIMEOUT", "request_timeout", 504],
  ] as const)(
    "classifies %s without reporting an internal server defect",
    async (nativeCode, responseCode, statusCode) => {
      const { app, records } = createLoggedTestApp();
      app.get("/interrupted", async () => {
        throw Object.assign(new Error("transport detail"), {
          code: nativeCode,
        });
      });

      const response = await app.inject({
        method: "GET",
        url: "/interrupted",
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({
        error: {
          code: responseCode,
          message:
            responseCode === "request_aborted"
              ? "Request was aborted"
              : "Request timed out",
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
    },
  );

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
