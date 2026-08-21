import type { FastifyInstance } from "fastify";

import { healthResponseSchema } from "@loomic/shared";

import type { ServerEnv } from "../config/env.js";

export async function registerHealthRoutes(
  app: FastifyInstance,
  env: ServerEnv,
  options: { realtimeReady?: () => boolean } = {},
) {
  app.get("/api/health", async (_request, reply) => {
    const payload = healthResponseSchema.parse({
      ok: true,
      service: "loomic-server",
      version: env.version,
    });

    return reply.code(200).send(payload);
  });

  app.get("/api/health/realtime", async (_request, reply) => {
    const ready = options.realtimeReady?.() ?? false;
    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      dependency: "postgres_realtime_listener",
    });
  });
}
