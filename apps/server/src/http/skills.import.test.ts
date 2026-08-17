import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { AppError } from "../errors/app-error.js";
import { SkillImportError } from "../features/skills/skill-import-service.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerSkillRoutes } from "./skills.js";

describe("skill import route", () => {
  it("rejects external imports while the capability is disabled", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    let importerCalled = false;
    await registerSkillRoutes(app, {
      allowExternalSkillImport: false,
      auth: { authenticate: async () => authenticatedUser },
      createUserClient: () => {
        throw new Error("database must not be reached");
      },
      importSkill: async () => {
        importerCalled = true;
        throw new AppError({
          code: "capability_disabled",
          statusCode: 403,
          message: "External skill import is disabled.",
          expose: true,
        });
      },
      viewerService: {
        ensureViewer: async () => {
          throw new Error("viewer must not be reached");
        },
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { url: "https://github.com/example/skill" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "capability_disabled" },
    });
    expect(importerCalled).toBe(true);
    await app.close();
  });

  it("does not write to the database when an archive budget is exceeded", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    let databaseCalled = false;
    await registerSkillRoutes(app, {
      allowExternalSkillImport: true,
      auth: { authenticate: async () => authenticatedUser },
      createUserClient: () =>
        ({
          from: () => {
            databaseCalled = true;
            throw new Error("database must not be reached");
          },
        }) as never,
      importSkill: async () => {
        throw new SkillImportError(
          "skill_archive_limit_exceeded",
          "Archive exceeds its resource budget.",
        );
      },
      viewerService: {
        ensureViewer: async () => ({ workspace: { id: "workspace-1" } }),
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { url: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
    });

    expect(response.statusCode).toBe(400);
    expect(databaseCalled).toBe(false);
    await app.close();
  });
});

const authenticatedUser = {
  accessToken: "token",
  email: "designer@example.com",
  id: "user-1",
  userMetadata: {},
};
