import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RequestAuthenticator } from "../supabase/user.js";

export type RateLimitBudgets = {
  defaultPerMinute: number;
  generationPerMinute: number;
  imageProxyPerMinute: number;
  skillImportPerHour: number;
  uploadsPerMinute: number;
};

export async function registerRateLimiting(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    budgets: RateLimitBudgets;
  },
) {
  await app.register(rateLimit, {
    global: true,
    allowList: (request) => routeGroup(request) === "health",
    keyGenerator: async (request) => {
      const user = await options.auth.authenticate(request);
      const identity = user ? `user:${user.id}` : `ip:${request.ip}`;
      return `${routeGroup(request)}:${identity}`;
    },
    max: async (request) => resolveBudget(request, options.budgets).max,
    timeWindow: async (request) =>
      resolveBudget(request, options.budgets).timeWindowMs,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: {
        code: "rate_limited",
        message: "Too many requests. Please try again later.",
      },
      retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
    }),
  });
}

function resolveBudget(request: FastifyRequest, budgets: RateLimitBudgets) {
  const group = routeGroup(request);
  if (group === "generation") {
    return { max: budgets.generationPerMinute, timeWindowMs: 60_000 };
  }
  if (group === "image-proxy") {
    return { max: budgets.imageProxyPerMinute, timeWindowMs: 60_000 };
  }
  if (group === "skill-import") {
    return { max: budgets.skillImportPerHour, timeWindowMs: 60 * 60_000 };
  }
  if (group === "uploads") {
    return { max: budgets.uploadsPerMinute, timeWindowMs: 60_000 };
  }
  return { max: budgets.defaultPerMinute, timeWindowMs: 60_000 };
}

function routeGroup(request: FastifyRequest) {
  const route = request.routeOptions.url ?? request.url.split("?", 1)[0] ?? "";
  if (route.startsWith("/api/health")) return "health";
  if (route === "/api/proxy-image") return "image-proxy";
  if (route === "/api/skills/import") return "skill-import";
  if (route.startsWith("/api/uploads")) return "uploads";
  if (
    route.startsWith("/api/generate") ||
    route.startsWith("/api/agent/runs")
  ) {
    return "generation";
  }
  return "default";
}
