import crypto from "node:crypto";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { BootstrapError } from "../features/bootstrap/ensure-user-foundation.js";
import { SettingsServiceError } from "../features/settings/settings-service.js";
import { UploadServiceError } from "../features/uploads/upload-service.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerPaymentWebhookRoute } from "./payments-webhook.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerMarketplaceRoutes } from "./skills-marketplace.js";
import { registerUploadRoutes } from "./uploads.js";
import { registerViewerRoutes } from "./viewer.js";

describe("high-risk route error boundaries", () => {
  it("returns a canonical 401 when a webhook signature is missing", async () => {
    const app = createApp();
    await registerPaymentWebhookRoute(app, webhookOptions);
    const response = await app.inject({
      method: "POST",
      url: "/api/payments/webhook",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
    await app.close();
  });

  it("returns canonical invalid_request for signed malformed webhook JSON", async () => {
    const app = createApp();
    await registerPaymentWebhookRoute(app, webhookOptions);
    const raw = "{";
    const signature = crypto
      .createHmac("sha256", "secret")
      .update(raw)
      .digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/api/payments/webhook",
      headers: { "content-type": "application/json", "x-signature": signature },
      payload: raw,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    await app.close();
  });

  it("keeps upload service validation errors canonical", async () => {
    const app = createApp();
    await app.register(multipart);
    await registerUploadRoutes(app, {
      auth,
      uploadService: {
        getAssetUrl: async () => {
          throw new UploadServiceError("asset_not_found", "missing", 404);
        },
      } as never,
      viewerService: {} as never,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/uploads/missing/url",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "asset_not_found" },
    });
    await app.close();
  });

  it("rejects an empty multipart upload canonically", async () => {
    const app = createApp();
    await app.register(multipart);
    await registerUploadRoutes(app, {
      auth,
      uploadService: {} as never,
      viewerService: {} as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: "--x--\r\n",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "upload_failed" } });
    await app.close();
  });

  it("rejects an invalid marketplace mutation before database access", async () => {
    const app = createApp();
    await registerMarketplaceRoutes(app, {
      auth,
      createUserClient: () => {
        throw new Error("database-secret");
      },
      viewerService: {} as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    await app.close();
  });

  it("preserves settings service status without leaking internals", async () => {
    const app = createApp();
    await registerSettingsRoutes(app, {
      auth,
      settingsService: {
        getWorkspaceSettings: async () => {
          throw new SettingsServiceError("settings_not_found", "missing", 404);
        },
      } as never,
      viewerService: {
        ensureViewer: async () => ({ workspace: { id: "w1" } }),
      } as never,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/settings",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "settings_not_found" },
    });
    await app.close();
  });

  it("keeps viewer bootstrap failures private", async () => {
    const app = createApp();
    await registerViewerRoutes(app, {
      auth,
      createUserClient: () => ({}) as never,
      viewerService: {
        ensureViewer: async () => {
          throw new BootstrapError();
        },
      },
    });
    const response = await app.inject({ method: "GET", url: "/api/viewer" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "application_error",
        message: "An unexpected error occurred",
      },
    });
    await app.close();
  });
});

function createApp() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  return app;
}
const user = {
  accessToken: "token",
  email: "u@example.com",
  id: "u1",
  userMetadata: {},
};
const auth = { authenticate: async () => user };
const webhookOptions = {
  webhookSecret: "secret",
  getAdminClient: () => ({}) as never,
  paymentService: {} as never,
};
