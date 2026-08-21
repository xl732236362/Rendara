import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerHealthRoutes } from "./health.js";

describe("realtime readiness", () => {
  it.each([
    [true, 200],
    [false, 503],
  ])(
    "reports listener connected=%s with HTTP %s",
    async (connected, status) => {
      const app = Fastify();
      await registerHealthRoutes(app, { version: "test" } as never, {
        realtimeReady: () => connected,
      });

      const response = await app.inject({ url: "/api/health/realtime" });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        ok: connected,
        dependency: "postgres_realtime_listener",
      });
      await app.close();
    },
  );
});
