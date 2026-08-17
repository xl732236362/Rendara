import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerRateLimiting } from "./rate-limit.js";

describe("HTTP rate limiting", () => {
  it("limits expensive routes by authenticated user with a stable error", async () => {
    const app = Fastify();
    await registerRateLimiting(app, {
      auth: { authenticate: async () => authenticatedUser },
      budgets: {
        defaultPerMinute: 100,
        generationPerMinute: 1,
        imageProxyPerMinute: 1,
        skillImportPerHour: 1,
        uploadsPerMinute: 1,
      },
    });
    app.post("/api/generate/image", async () => ({ ok: true }));

    expect(
      (await app.inject({ method: "POST", url: "/api/generate/image" }))
        .statusCode,
    ).toBe(200);
    const limited = await app.inject({
      method: "POST",
      url: "/api/generate/image",
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: { code: "rate_limited" },
    });
    await app.close();
  });

  it.each([
    ["GET", "/api/proxy-image"],
    ["POST", "/api/skills/import"],
    ["POST", "/api/uploads"],
  ] as const)("applies the strict budget for %s %s", async (method, url) => {
    const app = Fastify();
    await registerRateLimiting(app, {
      auth: { authenticate: async () => authenticatedUser },
      budgets: {
        defaultPerMinute: 100,
        generationPerMinute: 100,
        imageProxyPerMinute: 1,
        skillImportPerHour: 1,
        uploadsPerMinute: 1,
      },
    });
    app.route({ method, url, handler: async () => ({ ok: true }) });

    expect((await app.inject({ method, url })).statusCode).toBe(200);
    expect((await app.inject({ method, url })).statusCode).toBe(429);
    await app.close();
  });

  it("groups unauthenticated requests by IP", async () => {
    const app = Fastify();
    await registerRateLimiting(app, {
      auth: { authenticate: async () => null },
      budgets: {
        defaultPerMinute: 1,
        generationPerMinute: 1,
        imageProxyPerMinute: 1,
        skillImportPerHour: 1,
        uploadsPerMinute: 1,
      },
    });
    app.get("/api/models", async () => ({ ok: true }));

    expect((await app.inject({ url: "/api/models" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/models" })).statusCode).toBe(429);
    await app.close();
  });

  it("does not rate limit health checks", async () => {
    const app = Fastify();
    await registerRateLimiting(app, {
      auth: { authenticate: async () => null },
      budgets: {
        defaultPerMinute: 1,
        generationPerMinute: 1,
        imageProxyPerMinute: 1,
        skillImportPerHour: 1,
        uploadsPerMinute: 1,
      },
    });
    app.get("/api/health", async () => ({ ok: true }));

    for (let index = 0; index < 3; index += 1) {
      expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    }
    await app.close();
  });
});

const authenticatedUser = {
  accessToken: "token",
  email: "designer@example.com",
  id: "user-1",
  userMetadata: {},
};
