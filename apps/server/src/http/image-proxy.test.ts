import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { SafeFetchError } from "../security/safe-fetch.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerImageProxyRoute } from "./image-proxy.js";

describe("image proxy", () => {
  it("requires authentication before fetching", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    let fetched = false;
    await registerImageProxyRoute(app, {
      auth: { authenticate: async () => null },
      safeFetch: async () => {
        fetched = true;
        throw new Error("must not run");
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/proxy-image?url=https%3A%2F%2Freplicate.delivery%2Fa.png",
    });

    expect(response.statusCode).toBe(401);
    expect(fetched).toBe(false);
    await app.close();
  });

  it.each([
    ["unsafe_url", 403],
    ["response_too_large", 413],
    ["invalid_content_type", 415],
    ["request_timeout", 504],
    ["upstream_error", 502],
  ] as const)("maps %s to a stable response", async (code, statusCode) => {
    const app = Fastify();
    registerErrorHandler(app);
    await registerImageProxyRoute(app, {
      auth: { authenticate: async () => authenticatedUser },
      safeFetch: async () => {
        throw new SafeFetchError(code, "internal detail");
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/proxy-image?url=https%3A%2F%2Freplicate.delivery%2Fa.png",
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(response.body).not.toContain("internal detail");
    await app.close();
  });

  it("preserves the validated image MIME type", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    await registerImageProxyRoute(app, {
      auth: { authenticate: async () => authenticatedUser },
      safeFetch: async () => ({
        body: Buffer.from("image"),
        contentType: "image/png",
        finalUrl: new URL("https://replicate.delivery/a.png"),
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/proxy-image?url=https%3A%2F%2Freplicate.delivery%2Fa.png",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload.toString()).toBe("image");
    await app.close();
  });
});

const authenticatedUser = {
  accessToken: "token",
  email: "designer@example.com",
  id: "user-1",
  userMetadata: {},
};
