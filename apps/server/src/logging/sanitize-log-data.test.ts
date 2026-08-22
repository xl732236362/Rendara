import { describe, expect, it } from "vitest";

import { sanitizeLogData, sanitizeRequestUrl } from "./sanitize-log-data.js";

describe("log data sanitization", () => {
  it("redacts pagination cursors from URLs while preserving safe query parameters", () => {
    const sentinel = "sentinel-pagination-cursor";
    const sanitized = sanitizeRequestUrl(
      `/api/v2/projects?cursor=${sentinel}&limit=1`,
    );

    expect(sanitized).not.toContain(sentinel);
    expect(sanitized).toContain("cursor=%5BREDACTED%5D");
    expect(sanitized).toContain("limit=1");
  });

  it("redacts pagination cursors from structured log data", () => {
    const sentinel = "sentinel-pagination-cursor";
    const sanitized = JSON.stringify(
      sanitizeLogData({ cursor: sentinel, limit: 1 }),
    );

    expect(sanitized).not.toContain(sentinel);
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain('"limit":1');
  });

  it("redacts credentials from URLs and nested log data", () => {
    const sentinel = "sentinel-secret-token";
    const sanitized = sanitizeLogData({
      accessToken: sentinel,
      nested: { apiKey: sentinel, safe: "kept" },
      url: `/api/ws?token=${sentinel}&connectionId=connection-1`,
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain("connection-1");
    expect(serialized).toContain("kept");
    expect(sanitizeRequestUrl(`/api/ws?token=${sentinel}`)).not.toContain(
      sentinel,
    );
  });

  it("never returns unsanitized values at the depth or cycle boundary", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    cyclic.deep = { a: { b: { token: "sentinel-secret-token" } } };
    const serialized = JSON.stringify(sanitizeLogData(cyclic, { maxDepth: 2 }));
    expect(serialized).not.toContain("sentinel-secret-token");
    expect(serialized).toContain("[CIRCULAR]");
    expect(serialized).toContain("[TRUNCATED]");
  });

  it("redacts configured secret substrings inside otherwise safe strings", () => {
    expect(
      JSON.stringify(
        sanitizeLogData(
          { message: "Bearer configured-secret" },
          { secretValues: ["configured-secret"] },
        ),
      ),
    ).not.toContain("configured-secret");
  });
});
