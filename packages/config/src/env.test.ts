import { describe, expect, it } from "vitest";
import {
  EnvironmentValidationError,
  envDescriptors,
  parseServerEnvironment,
} from "./env.js";

describe("server environment schema", () => {
  it.each(["0", "65536", "3abc", "1.5", "not-a-port"])(
    "rejects invalid port %s",
    (port) => {
      expect(() =>
        parseServerEnvironment({ LOOMIC_SERVER_PORT: port }),
      ).toThrow(/LOOMIC_SERVER_PORT/);
    },
  );

  it.each(["0", "-1", "3abc", "1.5", "1001"])(
    "rejects an out-of-range worker concurrency %s",
    (value) => {
      expect(() =>
        parseServerEnvironment({ WORKER_CONCURRENCY: value }),
      ).toThrow(/WORKER_CONCURRENCY/);
    },
  );

  it("rejects invalid enums and URLs in one actionable error", () => {
    expect(() =>
      parseServerEnvironment({
        LOOMIC_AGENT_BACKEND_MODE: "memory",
        LOOMIC_WEB_ORIGIN: "not a url",
        OPENAI_API_BASE: "also not a url",
      }),
    ).toThrowError(
      /LOOMIC_AGENT_BACKEND_MODE[\s\S]*LOOMIC_WEB_ORIGIN[\s\S]*OPENAI_API_BASE/,
    );
  });

  it("trims strings and normalizes blank optional values", () => {
    const env = parseServerEnvironment({
      LOOMIC_AGENT_MODEL: "  custom-model  ",
      OPENAI_API_KEY: "   ",
      LOOMIC_SKILLS_ROOT: "  ./skills  ",
    });

    expect(env.agentModel).toBe("custom-model");
    expect(env.openAIApiKey).toBeUndefined();
    expect(env.skillsRoot).toBe("./skills");
  });

  it("enables dangerous capabilities only for the exact true literal", () => {
    expect(
      parseServerEnvironment({ LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: "true" })
        .allowLocalAgentExecute,
    ).toBe(true);
    for (const value of ["TRUE", "1", "yes", " true "]) {
      expect(
        parseServerEnvironment({ LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: value })
          .allowLocalAgentExecute,
      ).toBe(false);
    }
  });

  it("requires worker-only database configuration in worker mode", () => {
    expect(() => parseServerEnvironment({}, { process: "worker" })).toThrow(
      /SUPABASE_DB_URL/,
    );
    expect(() => parseServerEnvironment({}, { process: "api" })).not.toThrow();
  });

  it("requires configuration for an explicitly selected provider", () => {
    expect(() =>
      parseServerEnvironment({ LOOMIC_AGENT_MODEL: "openai:gpt-4.1" }),
    ).toThrow(/OPENAI_API_KEY/);
    expect(() =>
      parseServerEnvironment({
        LOOMIC_AGENT_MODEL: "google:gemini-2.5-flash",
        GOOGLE_API_KEY: "google-secret",
      }),
    ).not.toThrow();
  });

  it("publishes safe descriptor metadata without resolved values", () => {
    const openAI = envDescriptors.find(({ key }) => key === "OPENAI_API_KEY");
    const publicUrl = envDescriptors.find(
      ({ key }) => key === "NEXT_PUBLIC_SERVER_BASE_URL",
    );

    expect(openAI).toMatchObject({
      sensitivity: "secret",
      processes: ["api", "worker"],
    });
    expect(publicUrl).toMatchObject({
      sensitivity: "public",
      processes: ["web"],
    });
    expect(JSON.stringify(envDescriptors)).not.toContain("google-secret");
  });

  it("aggregates diagnostics and never includes secret values", () => {
    const secret = "sk-super-secret-material";
    let error: unknown;
    try {
      parseServerEnvironment({
        LOOMIC_AGENT_MODEL: "openai:gpt-4.1",
        OPENAI_API_KEY: secret,
        OPENAI_API_BASE: secret,
        LOOMIC_SERVER_PORT: "70000",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EnvironmentValidationError);
    expect(String(error)).toContain("OPENAI_API_BASE");
    expect(String(error)).toContain("LOOMIC_SERVER_PORT");
    expect(String(error)).not.toContain(secret);
  });
});
