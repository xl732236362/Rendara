import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../errors/app-error.js";
import { registerCanvasRoutes } from "./canvases.js";
import { registerErrorHandler } from "./error-handler.js";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  accessToken: "token",
  email: "",
  userMetadata: {},
};

async function createApp(
  saveCanvasContent: (...args: never[]) => Promise<unknown>,
) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerCanvasRoutes(app, {
    auth: { authenticate: async () => user },
    canvasService: {
      getCanvas: async () => {
        throw new Error("unused");
      },
      saveCanvasContent: saveCanvasContent as never,
    },
  });
  return app;
}

describe("Canvas revision HTTP contract", () => {
  it("requires expectedRevision", async () => {
    const app = await createApp(vi.fn());
    const response = await app.inject({
      method: "PUT",
      url: "/api/canvases/22222222-2222-4222-8222-222222222222",
      payload: { content: { elements: [], appState: {}, files: {} } },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("passes expected revision and returns the committed revision", async () => {
    const save = vi.fn(async () => ({ revision: 4 }));
    const app = await createApp(save);
    const content = { elements: [], appState: {}, files: {} };
    const response = await app.inject({
      method: "PUT",
      url: "/api/canvases/22222222-2222-4222-8222-222222222222",
      payload: { expectedRevision: 3, content },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, revision: 4 });
    expect(save).toHaveBeenCalledWith(
      user,
      "22222222-2222-4222-8222-222222222222",
      3,
      content,
    );
    await app.close();
  });

  it("surfaces a safe revision conflict", async () => {
    const app = await createApp(
      vi.fn(async () => {
        throw new AppError({
          code: "canvas_revision_conflict",
          statusCode: 409,
          message: "The Canvas changed since it was loaded.",
          expose: true,
          details: { expectedRevision: 3, currentRevision: 5 },
        });
      }),
    );
    const response = await app.inject({
      method: "PUT",
      url: "/api/canvases/22222222-2222-4222-8222-222222222222",
      payload: {
        expectedRevision: 3,
        content: { elements: [], appState: {}, files: {} },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "canvas_revision_conflict",
        details: { expectedRevision: 3, currentRevision: 5 },
      },
    });
    await app.close();
  });
});
