import { describe, expect, it } from "vitest";
import { createAgentBackend } from "../agent/backends/index.js";
import { loadServerEnv } from "./env.js";

describe("security capability defaults", () => {
  it("disables local execute and external skill imports by default", () => {
    const env = loadServerEnv({}, {});

    expect(env.allowLocalAgentExecute).toBe(false);
    expect(env.allowExternalSkillImport).toBe(false);
  });

  it("only enables capabilities from the exact true literal", () => {
    expect(
      loadServerEnv({}, { LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: "true" })
        .allowLocalAgentExecute,
    ).toBe(true);
    expect(
      loadServerEnv({}, { LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: "1" })
        .allowLocalAgentExecute,
    ).toBe(false);
  });
});

describe("production agent execution", () => {
  it("rejects local execution unless explicitly enabled", () => {
    expect(() =>
      createAgentBackend(
        {
          agentBackendMode: "state",
          allowLocalAgentExecute: false,
        },
        "canvas-1",
      ),
    ).toThrow(
      "Production code execution requires an isolated sandbox provider",
    );
  });
});

describe("rate limit configuration", () => {
  it("uses conservative defaults", () => {
    const env = loadServerEnv({}, {});

    expect(env.rateLimitGenerationPerMinute).toBe(10);
    expect(env.rateLimitImageProxyPerMinute).toBe(60);
    expect(env.rateLimitSkillImportPerHour).toBe(5);
    expect(env.rateLimitUploadsPerMinute).toBe(20);
  });

  it.each(["0", "-1", "not-a-number"])(
    "rejects invalid rate limit value %s",
    (value) => {
      expect(() =>
        loadServerEnv({}, { LOOMIC_RATE_LIMIT_GENERATION_PER_MINUTE: value }),
      ).toThrow("LOOMIC_RATE_LIMIT_GENERATION_PER_MINUTE");
    },
  );
});
