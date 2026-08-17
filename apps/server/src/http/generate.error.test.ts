import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearProviders,
  registerImageProvider,
} from "../generation/providers/registry.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerGenerateRoutes } from "./generate.js";

describe("generation route errors", () => {
  afterEach(() => clearProviders());

  it("maps an unavailable provider to a safe 502", async () => {
    clearProviders();
    const app = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/generate-image",
      payload: { prompt: "hello", model: "missing/model" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "generation_failed",
        message: "Image generation is unavailable.",
      },
    });
    await app.close();
  });

  it("keeps provider failures private behind generation_failed", async () => {
    registerImageProvider({
      name: "test",
      models: [{ id: "test/model", displayName: "Test", description: "Test" }],
      generate: async () => {
        throw new Error("provider-api-key-secret");
      },
    });
    const app = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/generate-image",
      payload: { prompt: "hello", model: "test/model" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { code: "generation_failed", message: "Image generation failed." },
    });
    expect(response.body).not.toContain("secret");
    await app.close();
  });

  it("maps upload failures to a safe generation_failed 502", async () => {
    registerImageProvider({
      name: "test",
      models: [{ id: "test/model", displayName: "Test", description: "Test" }],
      generate: async () => ({
        url: "data:image/png;base64,aW1hZ2U=",
        mimeType: "image/png",
        width: 1,
        height: 1,
      }),
    });
    const app = await createApp({
      uploadFile: async () => {
        throw new Error("storage-secret");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/generate-image",
      payload: { prompt: "hello", model: "test/model" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "generation_failed",
        message: "Generated image could not be stored.",
      },
    });
    await app.close();
  });

  it("maps video job creation failures to a safe 502", async () => {
    const app = await createApp(undefined, {
      createJob: async () => {
        throw new Error("queue-secret");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/generate-video",
      payload: { prompt: "hello" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "generation_failed",
        message: "Video generation could not be started.",
      },
    });
    await app.close();
  });

  it("maps video polling failures to a safe 502", async () => {
    const app = await createApp(undefined, {
      createJob: async () => ({ id: "j1" }),
      getJobAdmin: async () => {
        throw new Error("poll-secret");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/generate-video",
      payload: { prompt: "hello" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "generation_failed",
        message: "Video generation status could not be retrieved.",
      },
    });
    await app.close();
  }, 10_000);
});

async function createApp(uploadService: unknown = {}, jobService?: unknown) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerGenerateRoutes(app, {
    auth: {
      authenticate: async () => ({
        accessToken: "token",
        email: "u@example.com",
        id: "u1",
        userMetadata: {},
      }),
    },
    uploadService: uploadService as never,
    ...(jobService ? { jobService: jobService as never } : {}),
    viewerService: {
      ensureViewer: async () => ({ workspace: { id: "w1" } }),
    } as never,
  });
  return app;
}
