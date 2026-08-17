import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadServerEnv } from "../../config/env.js";
import { registerModelRoutes } from "../../http/models.js";
import { OpenAIImageProvider } from "./openai-image.js";

describe("OpenAI model configuration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes gpt-image-2 through the image provider", () => {
    const provider = new OpenAIImageProvider(
      "test-key",
      "https://example.test/v1",
    );

    expect(provider.models).toContainEqual(
      expect.objectContaining({
        id: "gpt-image-2",
        displayName: "GPT Image 2",
      }),
    );
  });

  it("exposes gpt-5.6-terra when OpenAI is configured", async () => {
    const app = Fastify();
    const env = loadServerEnv({}, { OPENAI_API_KEY: "test-key" });
    await registerModelRoutes(app, env);

    const response = await app.inject({ method: "GET", url: "/api/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json().models).toContainEqual({
      id: "openai:gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      provider: "openai",
    });

    await app.close();
  });

  it("returns GPT Image base64 output as a fetchable data URL", async () => {
    const fetchDataUrl = globalThis.fetch;
    const imageBase64 = Buffer.from("generated-image-bytes").toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            created: 1,
            data: [{ b64_json: imageBase64 }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const provider = new OpenAIImageProvider(
      "test-key",
      "https://example.test/v1",
    );

    const result = await provider.generate({
      model: "gpt-image-2",
      prompt: "A test image",
      aspectRatio: "1:1",
    });

    expect(result).toMatchObject({
      url: `data:image/png;base64,${imageBase64}`,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });

    const downloaded = await fetchDataUrl(result.url);
    expect(Buffer.from(await downloaded.arrayBuffer()).toString()).toBe(
      "generated-image-bytes",
    );
  });
});
