import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
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
      OPENAI_API_KEY: "  openai-secret  ",
      REPLICATE_API_TOKEN: "   ",
      LOOMIC_SKILLS_ROOT: "  ./skills  ",
    });

    expect(env.agentModel).toBe("custom-model");
    expect(env.openAIApiKey).toBe("openai-secret");
    expect(env.replicateApiToken).toBeUndefined();
    expect(env.skillsRoot).toBe("./skills");
  });

  it("enables dangerous capabilities only for the exact true literal", () => {
    expect(
      parseServerEnvironment({ LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: "true" })
        .allowLocalAgentExecute,
    ).toBe(true);
  });

  it.each(["TRUE", "1", "yes", " true ", null, 1, {}])(
    "rejects invalid supplied boolean %j",
    (value) => {
      expect(() =>
        parseServerEnvironment({ LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: value }),
      ).toThrow(/LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE/);
    },
  );

  it("accepts exact false and typed booleans", () => {
    expect(
      parseServerEnvironment({ LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: "false" })
        .allowLocalAgentExecute,
    ).toBe(false);
    expect(
      parseServerEnvironment({ LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: true })
        .allowLocalAgentExecute,
    ).toBe(true);
  });

  it("requires production API dependencies and its resolved default provider", () => {
    expect(() => parseServerEnvironment({}, { process: "api" })).toThrow(
      /SUPABASE_URL[\s\S]*SUPABASE_ANON_KEY[\s\S]*SUPABASE_SERVICE_ROLE_KEY[\s\S]*OPENAI_API_KEY/,
    );
  });

  it("requires worker dependencies and its resolved default provider", () => {
    expect(() => parseServerEnvironment({}, { process: "worker" })).toThrow(
      /SUPABASE_URL[\s\S]*SUPABASE_ANON_KEY[\s\S]*SUPABASE_SERVICE_ROLE_KEY[\s\S]*SUPABASE_DB_URL[\s\S]*OPENAI_API_KEY/,
    );
  });

  it("accepts a complete Google default provider path", () => {
    expect(() =>
      parseServerEnvironment(
        {
          GOOGLE_API_KEY: "google-secret",
          SUPABASE_ANON_KEY: "anon",
          SUPABASE_SERVICE_ROLE_KEY: "service",
          SUPABASE_URL: "https://example.supabase.co",
        },
        { process: "api" },
      ),
    ).not.toThrow();
  });

  it("requires credentials for the resolved Vertex provider path", () => {
    expect(() =>
      parseServerEnvironment(
        {
          GOOGLE_VERTEX_LOCATION: "us-central1",
          GOOGLE_VERTEX_PROJECT: "project",
          SUPABASE_ANON_KEY: "anon",
          SUPABASE_SERVICE_ROLE_KEY: "service",
          SUPABASE_URL: "https://example.supabase.co",
        },
        { process: "api" },
      ),
    ).toThrow(
      /GOOGLE_APPLICATION_CREDENTIALS[\s\S]*GOOGLE_SERVICE_ACCOUNT_JSON/,
    );
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

    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(String(error)).toContain("OPENAI_API_BASE");
    expect(String(error)).toContain("LOOMIC_SERVER_PORT");
    expect(String(error)).not.toContain(secret);
  });

  it("aggregates schema, process, and provider issues before failing", () => {
    const secret = "invalid-secret-url";
    const source = {
      LOOMIC_AGENT_MODEL: "openai:gpt-4.1",
      LOOMIC_SERVER_PORT: "70000",
      OPENAI_API_BASE: secret,
    };
    expect(() => parseServerEnvironment(source, { process: "worker" })).toThrow(
      /LOOMIC_SERVER_PORT[\s\S]*OPENAI_API_BASE[\s\S]*SUPABASE_DB_URL[\s\S]*OPENAI_API_KEY/,
    );
    try {
      parseServerEnvironment(source, { process: "worker" });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
