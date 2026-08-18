import { describe, expect, it } from "vitest";
import { loadServerEnv } from "./env.js";

describe("validated server environment adapter", () => {
  it("validates typed overrides instead of bypassing the schema", () => {
    expect(() => loadServerEnv({ port: 70_000 }, {})).toThrow(
      /LOOMIC_SERVER_PORT/,
    );
  });

  it("aggregates invalid source fields and redacts credentials", () => {
    const secret = "do-not-print-this-secret";
    expect(() =>
      loadServerEnv(
        {},
        {
          LOOMIC_SERVER_PORT: "0",
          SUPABASE_URL: secret,
          WORKER_IMAGE_CONCURRENCY: "3abc",
        },
      ),
    ).toThrow(
      /LOOMIC_SERVER_PORT[\s\S]*SUPABASE_URL[\s\S]*WORKER_IMAGE_CONCURRENCY/,
    );

    try {
      loadServerEnv({}, { SUPABASE_URL: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("fails worker configuration before process composition", () => {
    expect(() => loadServerEnv({}, {}, { process: "worker" })).toThrow(
      /SUPABASE_DB_URL/,
    );
  });
});

describe("security capability defaults", () => {
  it("disables external skill imports by default", () => {
    const env = loadServerEnv({}, {});

    expect(env.allowExternalSkillImport).toBe(false);
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
