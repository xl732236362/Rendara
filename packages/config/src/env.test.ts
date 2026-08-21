import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  envDescriptors,
  parseServerEnvironment,
} from "./env.js";

describe("server environment schema", () => {
  const completeApiEnvironment = {
    GOOGLE_API_KEY: "google-secret",
    LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY:
      "active-pagination-signing-secret-32-bytes",
    LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY_ID: "active-2026-08",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_DB_URL: "postgresql://example",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    SUPABASE_URL: "https://example.supabase.co",
  };

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

  it("rejects invalid URLs in one actionable error", () => {
    expect(() =>
      parseServerEnvironment({
        LOOMIC_WEB_ORIGIN: "not a url",
        OPENAI_API_BASE: "also not a url",
      }),
    ).toThrowError(/LOOMIC_WEB_ORIGIN[\s\S]*OPENAI_API_BASE/);
  });

  it("trims strings and normalizes blank optional values", () => {
    const env = parseServerEnvironment({
      LOOMIC_AGENT_MODEL: "  custom-model  ",
      OPENAI_API_KEY: "  openai-secret  ",
      REPLICATE_API_TOKEN: "   ",
    });

    expect(env.agentModel).toBe("custom-model");
    expect(env.openAIApiKey).toBe("openai-secret");
    expect(env.replicateApiToken).toBeUndefined();
  });

  it("requires production API dependencies and its resolved default provider", () => {
    expect(() => parseServerEnvironment({}, { process: "api" })).toThrow(
      /SUPABASE_URL[\s\S]*SUPABASE_ANON_KEY[\s\S]*SUPABASE_SERVICE_ROLE_KEY[\s\S]*SUPABASE_DB_URL[\s\S]*LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY_ID[\s\S]*LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY[\s\S]*OPENAI_API_KEY/,
    );
  });

  it("requires worker dependencies and its resolved default provider", () => {
    expect(() => parseServerEnvironment({}, { process: "worker" })).toThrow(
      /SUPABASE_URL[\s\S]*SUPABASE_ANON_KEY[\s\S]*SUPABASE_SERVICE_ROLE_KEY[\s\S]*SUPABASE_DB_URL[\s\S]*OPENAI_API_KEY/,
    );
  });

  it("accepts a complete Google default provider path", () => {
    expect(() =>
      parseServerEnvironment(completeApiEnvironment, { process: "api" }),
    ).not.toThrow();
  });

  it("does not require pagination cursor keys outside the API process", () => {
    const env = parseServerEnvironment({});

    expect(env.paginationCursorActiveKeyId).toBeUndefined();
    expect(env.paginationCursorActiveKey).toBeUndefined();
  });

  it.each([
    ["missing key ID", { LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY_ID: undefined }],
    ["missing key", { LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY: undefined }],
  ])("requires the active pagination cursor %s for API", (_, overrides) => {
    expect(() =>
      parseServerEnvironment(
        { ...completeApiEnvironment, ...overrides },
        { process: "api" },
      ),
    ).toThrow(/LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY/);
  });

  it("measures pagination cursor secrets by UTF-8 bytes", () => {
    expect(() =>
      parseServerEnvironment(
        {
          ...completeApiEnvironment,
          LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY: "密钥材料".repeat(3),
        },
        { process: "api" },
      ),
    ).not.toThrow();
    expect(() =>
      parseServerEnvironment(
        {
          ...completeApiEnvironment,
          LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY: "x".repeat(31),
        },
        { process: "api" },
      ),
    ).toThrow(/LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY/);
  });

  it.each([
    [
      "ID",
      {
        LOOMIC_PAGINATION_CURSOR_PREVIOUS_KEY_ID: "previous-2026-07",
      },
    ],
    [
      "secret",
      {
        LOOMIC_PAGINATION_CURSOR_PREVIOUS_KEY:
          "previous-pagination-signing-secret-32-bytes",
      },
    ],
  ])(
    "requires the previous pagination cursor %s and secret as a pair",
    (_, previous) => {
      expect(() =>
        parseServerEnvironment(
          { ...completeApiEnvironment, ...previous },
          { process: "api" },
        ),
      ).toThrow(/LOOMIC_PAGINATION_CURSOR_PREVIOUS_KEY/);
    },
  );

  it("requires distinct active and previous pagination cursor key IDs", () => {
    expect(() =>
      parseServerEnvironment(
        {
          ...completeApiEnvironment,
          LOOMIC_PAGINATION_CURSOR_PREVIOUS_KEY:
            "previous-pagination-signing-secret-32-bytes",
          LOOMIC_PAGINATION_CURSOR_PREVIOUS_KEY_ID: "active-2026-08",
        },
        { process: "api" },
      ),
    ).toThrow(/LOOMIC_PAGINATION_CURSOR_PREVIOUS_KEY_ID/);
  });

  it("maps cursor keys to typed properties without exposing secrets in errors", () => {
    const secret = "active-pagination-signing-secret-32-bytes";
    const env = parseServerEnvironment(
      {
        ...completeApiEnvironment,
        LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY: secret,
      },
      { process: "api" },
    );

    expect(env).toMatchObject({
      paginationCursorActiveKey: secret,
      paginationCursorActiveKeyId: "active-2026-08",
    });

    try {
      parseServerEnvironment(
        {
          ...completeApiEnvironment,
          LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY: "too-short-secret",
        },
        { process: "api" },
      );
    } catch (error) {
      expect(String(error)).not.toContain("too-short-secret");
    }
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
    expect(
      envDescriptors.find(({ key }) => key === "SUPABASE_DB_URL"),
    ).toMatchObject({
      sensitivity: "secret",
      processes: ["api", "worker"],
      requiredFor: ["api", "worker"],
    });
    expect(
      envDescriptors.find(
        ({ key }) => key === "LOOMIC_PAGINATION_CURSOR_ACTIVE_KEY",
      ),
    ).toMatchObject({
      sensitivity: "secret",
      processes: ["api"],
      requiredFor: ["api"],
    });
    expect(
      envDescriptors.find(
        ({ key }) => key === "LOOMIC_PAGINATION_CURSOR_PREVIOUS_KEY",
      ),
    ).toMatchObject({
      sensitivity: "secret",
      processes: ["api"],
    });
    expect(JSON.stringify(envDescriptors)).not.toContain("google-secret");
  });

  it("provides bounded Agent deadline and lease defaults", () => {
    const env = parseServerEnvironment({});
    expect(env).toMatchObject({
      agentModelInactivityMs: 30_000,
      agentToolDeadlineMs: 600_000,
      agentOverallDeadlineMs: 900_000,
      agentAttemptLeaseMs: 60_000,
      agentAttemptRenewIntervalMs: 15_000,
    });
  });

  it.each([
    ["LOOMIC_AGENT_MODEL_INACTIVITY_MS", "999"],
    ["LOOMIC_AGENT_TOOL_DEADLINE_MS", "999"],
    ["LOOMIC_AGENT_OVERALL_DEADLINE_MS", "999"],
    ["LOOMIC_AGENT_ATTEMPT_LEASE_MS", "4999"],
    ["LOOMIC_AGENT_ATTEMPT_RENEW_INTERVAL_MS", "999"],
  ])("rejects unsafe Agent timing %s=%s", (key, value) => {
    expect(() => parseServerEnvironment({ [key]: value })).toThrow(key);
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
