import { describe, expect, it } from "vitest";
import { buildAppFromEnv, buildAppWithOverrides } from "./app.js";
import { loadServerEnv } from "./config/env.js";

describe("application environment composition", () => {
  it("accepts an already parsed production environment without parsing it again", async () => {
    const env = loadServerEnv({ version: "parse-once-test" }, {});
    const app = buildAppFromEnv(env);

    expect(env.version).toBe("parse-once-test");
    await app.close();
  });

  it("keeps partial test overrides behind validation", () => {
    expect(() => buildAppWithOverrides({ env: { port: 70_000 } })).toThrow(
      /LOOMIC_SERVER_PORT/,
    );
  });
});
