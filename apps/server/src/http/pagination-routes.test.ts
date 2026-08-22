import { errorEnvelopeSchema } from "@loomic/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../errors/app-error.js";
import { registerBrandKitRoutes } from "./brand-kits.js";
import { registerChatRoutes } from "./chat.js";
import { registerCreditRoutes } from "./credits.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerProjectRoutes } from "./projects.js";

const user = {
  accessToken: "token",
  email: "user@example.com",
  id: "user-1",
  userMetadata: {},
};
const viewer = { workspace: { id: "workspace-1" } };

describe("versioned pagination routes", () => {
  it.each([
    ["projects", "/api/v2/projects", "listProjectsPage"],
    ["brand kits", "/api/v2/brand-kits", "listKitsPage"],
    [
      "credit transactions",
      "/api/v2/credits/transactions",
      "listTransactionsPage",
    ],
    [
      "canvas sessions",
      "/api/v2/canvases/canvas-1/sessions",
      "listSessionsPage",
    ],
    [
      "session messages",
      "/api/v2/sessions/session-1/messages",
      "listMessagesPage",
    ],
  ] as const)(
    "registers the exact %s path with the default limit",
    async (domain, url, method) => {
      const { app, services } = await createApp();
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode, domain).toBe(200);
      expect(response.json()).toEqual({ items: [], nextCursor: null });
      expect(services[method]).toHaveBeenCalledOnce();
      expect(services[method].mock.calls[0]?.at(-1)).toEqual({ limit: 50 });
      await app.close();
    },
  );

  it("accepts the maximum limit and rejects values above it", async () => {
    const { app, services } = await createApp();
    const accepted = await app.inject({
      method: "GET",
      url: "/api/v2/projects?limit=100",
    });
    const rejected = await app.inject({
      method: "GET",
      url: "/api/v2/projects?limit=101",
    });

    expect(accepted.statusCode).toBe(200);
    expect(services.listProjectsPage).toHaveBeenCalledWith(user, {
      limit: 100,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    await app.close();
  });

  it("authenticates before calling a paged service", async () => {
    const { app, services } = await createApp({ authenticated: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/v2/projects",
    });

    expect(response.statusCode).toBe(401);
    expect(services.listProjectsPage).not.toHaveBeenCalled();
    await app.close();
  });

  it("derives brand-kit and credit scope from the authenticated viewer", async () => {
    const { app, services } = await createApp();
    await app.inject({ method: "GET", url: "/api/v2/brand-kits" });
    await app.inject({ method: "GET", url: "/api/v2/credits/transactions" });

    expect(services.listKitsPage).toHaveBeenCalledWith(user, "workspace-1", {
      limit: 50,
    });
    expect(services.listTransactionsPage).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      { limit: 50 },
    );
    await app.close();
  });

  it("does not accept workspace or user scope from the query string", async () => {
    const { app, services } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v2/credits/transactions?workspaceId=attacker&userId=attacker",
    });

    expect(response.statusCode).toBe(400);
    expect(services.listTransactionsPage).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the stable invalid-cursor envelope without leaking cursor material", async () => {
    const { app, services } = await createApp();
    services.listProjectsPage.mockRejectedValueOnce(
      new AppError({
        code: "invalid_cursor",
        statusCode: 400,
        message: "Invalid pagination cursor.",
        expose: true,
      }),
    );
    const cursor = "signed-secret-cursor";
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/projects?cursor=${cursor}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_cursor" },
    });
    expect(() => errorEnvelopeSchema.parse(response.json())).not.toThrow();
    expect(response.body).not.toContain(cursor);
    await app.close();
  });

  it("parses paged service output through the item response schema", async () => {
    const { app, services } = await createApp();
    services.listProjectsPage.mockResolvedValueOnce({
      items: [{ id: "incomplete" }],
      nextCursor: null,
    } as never);
    const response = await app.inject({
      method: "GET",
      url: "/api/v2/projects",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "application_error" },
    });
    expect(response.body).not.toContain("incomplete");
    await app.close();
  });

  it("preserves legacy collection response shapes", async () => {
    const { app } = await createApp();
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/projects" }),
      app.inject({ method: "GET", url: "/api/brand-kits" }),
      app.inject({ method: "GET", url: "/api/credits/transactions" }),
      app.inject({ method: "GET", url: "/api/canvases/canvas-1/sessions" }),
      app.inject({ method: "GET", url: "/api/sessions/session-1/messages" }),
    ]);

    expect(responses.map((response) => response.json())).toEqual([
      { projects: [] },
      { brandKits: [] },
      { transactions: [] },
      { sessions: [] },
      { messages: [] },
    ]);
    await app.close();
  });
});

async function createApp(options: { authenticated?: boolean } = {}) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  const auth = {
    authenticate: vi.fn(async () =>
      options.authenticated === false ? null : user,
    ),
  };
  const viewerService = { ensureViewer: vi.fn(async () => viewer) };
  const emptyPage = async (..._args: unknown[]) => ({
    items: [],
    nextCursor: null,
  });
  const services = {
    listProjectsPage: vi.fn(emptyPage),
    listKitsPage: vi.fn(emptyPage),
    listTransactionsPage: vi.fn(emptyPage),
    listSessionsPage: vi.fn(emptyPage),
    listMessagesPage: vi.fn(emptyPage),
  };

  await registerProjectRoutes(app, {
    auth,
    projectService: {
      listProjects: async () => [],
      listProjectsPage: services.listProjectsPage,
    } as never,
  });
  await registerBrandKitRoutes(app, {
    auth,
    brandKitService: {
      listKits: async () => [],
      listKitsPage: services.listKitsPage,
    } as never,
    viewerService,
  } as never);
  await registerCreditRoutes(app, {
    auth,
    creditService: {
      getTransactions: async () => [],
      listTransactionsPage: services.listTransactionsPage,
    } as never,
    viewerService: viewerService as never,
  });
  await registerChatRoutes(app, {
    auth,
    chatService: {
      listSessions: async () => [],
      listMessages: async () => [],
      listSessionsPage: services.listSessionsPage,
      listMessagesPage: services.listMessagesPage,
    } as never,
  });
  return { app, services };
}
