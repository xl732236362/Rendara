import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import { z } from "zod";

import {
  ApiAbortError,
  ApiApplicationError,
  ApiAuthError,
  ApiProtocolError,
  ApiTimeoutError,
  apiFetch,
} from "../src/lib/api-client";
import { registerApiAuthExpiryHandler } from "../src/lib/auth-expiry";

const mockFetch = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("apiFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("parses successful JSON with the response schema", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "p1" }));

    await expect(
      apiFetch({
        method: "GET",
        path: "/api/projects/p1",
        responseSchema: z.object({ id: z.string() }),
      }),
    ).resolves.toEqual({ id: "p1" });
  });

  it("preserves legacy application and auth error constructors", () => {
    const legacy = new ApiApplicationError(
      "legacy_provider_error",
      "Legacy failure",
    );
    const customAuth = new ApiAuthError("Session expired");

    expect(legacy).toMatchObject({
      name: "ApiApplicationError",
      code: "legacy_provider_error",
      message: "Legacy failure",
    });
    expect(customAuth).toMatchObject({
      name: "ApiAuthError",
      code: "unauthorized",
      message: "Session expired",
    });
  });

  it.each([
    ["http://localhost:3001", "/api/ok", "http://localhost:3001/api/ok"],
    ["http://localhost:3001", "api/ok", "http://localhost:3001/api/ok"],
    ["http://localhost:3001/", "/api/ok", "http://localhost:3001/api/ok"],
    ["http://localhost:3001/", "api/ok", "http://localhost:3001/api/ok"],
    [
      "http://localhost:3001/gateway",
      "/api/ok?q=one%20two",
      "http://localhost:3001/gateway/api/ok?q=one%20two",
    ],
    [
      "http://localhost:3001/gateway/",
      "api/ok?q=one%20two",
      "http://localhost:3001/gateway/api/ok?q=one%20two",
    ],
  ])("joins base %s and path %s", async (base, path, expected) => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", base);
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch({
      method: "GET",
      path,
      responseSchema: z.object({ ok: z.literal(true) }),
    });

    expect(mockFetch.mock.calls[0]?.[0]).toBe(expected);
  });

  it("rejects a malformed API base URL before fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "not a valid URL");

    await expect(
      apiFetch({ method: "GET", path: "/api/ok", responseSchema: z.unknown() }),
    ).rejects.toMatchObject({
      name: "ApiProtocolError",
      message: "API base URL is invalid",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws a private protocol error for malformed successful JSON", async () => {
    mockFetch.mockResolvedValue(
      new Response("secret raw response", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      apiFetch({
        method: "GET",
        path: "/api/projects/p1",
        responseSchema: z.object({ id: z.string() }),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ApiProtocolError",
        message: "API returned malformed JSON",
      }),
    );

    await apiFetch({
      method: "GET",
      path: "/api/projects/p1",
      responseSchema: z.object({ id: z.string() }),
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiProtocolError);
      expect(String(error)).not.toContain("secret raw response");
    });
  });

  it("throws a private protocol error for an invalid success payload", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 123, internal: "secret" }));

    await expect(
      apiFetch({
        method: "GET",
        path: "/api/projects/p1",
        responseSchema: z.object({ id: z.string() }),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ApiProtocolError",
        message: "API returned an invalid response",
      }),
    );
  });

  it("parses canonical application errors and exposes only safe fields", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "project_not_found",
            message: "Project not found",
            details: { projectId: "p1" },
          },
          extra: "ignored",
        },
        { status: 404 },
      ),
    );

    const error = await apiFetch({
      method: "GET",
      path: "/api/projects/p1",
      responseSchema: z.object({ id: z.string() }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiApplicationError);
    expect(error).toMatchObject({
      code: "project_not_found",
      message: "Project not found",
      details: { projectId: "p1" },
    });
    expect(error).not.toHaveProperty("extra");
  });

  it("uses a safe fallback for malformed or noncanonical error payloads", async () => {
    mockFetch.mockResolvedValue(
      new Response("upstream secret", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );

    const error = await apiFetch({
      method: "GET",
      path: "/api/projects",
      responseSchema: z.object({ projects: z.array(z.unknown()) }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiApplicationError);
    expect(error).toMatchObject({
      code: "application_error",
      message: "Request failed",
    });
    expect(String(error)).not.toContain("upstream secret");
  });

  it("preserves a safe correlation id on private server failures", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "application_error",
            message: "An unexpected error occurred",
            correlationId: "request-canvas-save-1",
          },
        },
        {
          status: 500,
          headers: { "x-correlation-id": "request-canvas-save-1" },
        },
      ),
    );

    const error = await apiFetch({
      method: "PUT",
      path: "/api/canvases/canvas-1",
      responseSchema: z.unknown(),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "ApiApplicationError",
      code: "application_error",
      status: 500,
      correlationId: "request-canvas-save-1",
      message: "An unexpected error occurred",
    });
  });

  it("specializes every 401 as an auth error", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        { error: { code: "unauthorized", message: "Token leaked" } },
        { status: 401 },
      ),
    );

    await expect(
      apiFetch({
        method: "GET",
        path: "/api/viewer",
        accessToken: "private-token",
        responseSchema: z.unknown(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ApiAuthError",
        message: "unauthorized",
      }),
    );
    await expect(
      apiFetch({
        method: "GET",
        path: "/api/viewer",
        accessToken: "private-token",
        responseSchema: z.unknown(),
      }),
    ).rejects.toBeInstanceOf(ApiAuthError);
  });

  it("notifies the registered auth boundary only for HTTP 401", async () => {
    const onAuthExpired = vi.fn();
    const unregister = registerApiAuthExpiryHandler(onAuthExpired);
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "unauthorized", message: "expired" } },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "forbidden", message: "forbidden" } },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "application_error",
              message: "An unexpected error occurred",
            },
          },
          { status: 500 },
        ),
      );

    for (let index = 0; index < 3; index += 1) {
      await apiFetch({
        method: "GET",
        path: "/api/canvas-boundary",
        responseSchema: z.unknown(),
      }).catch(() => undefined);
    }

    expect(onAuthExpired).toHaveBeenCalledOnce();
    unregister();
  });

  it("distinguishes timeout from caller abort", async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const timedOut = apiFetch({
      method: "GET",
      path: "/api/slow",
      responseSchema: z.unknown(),
      timeoutMs: 25,
    });
    const timeoutExpectation =
      expect(timedOut).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await timeoutExpectation;

    const caller = new AbortController();
    const aborted = apiFetch({
      method: "GET",
      path: "/api/slow",
      responseSchema: z.unknown(),
      signal: caller.signal,
      timeoutMs: 100,
    });
    caller.abort();
    await expect(aborted).rejects.toBeInstanceOf(ApiAbortError);
  });

  it("preserves caller abort classification when fetch rejects late", async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              setTimeout(
                () => reject(new DOMException("aborted", "AbortError")),
                50,
              );
            },
            { once: true },
          );
        }),
    );

    const caller = new AbortController();
    const request = apiFetch({
      method: "GET",
      path: "/api/slow",
      responseSchema: z.unknown(),
      signal: caller.signal,
      timeoutMs: 25,
    });
    const caught = request.catch((error: unknown) => error);
    caller.abort();
    await vi.advanceTimersByTimeAsync(75);
    expect(await caught).toBeInstanceOf(ApiAbortError);
  });

  it("returns undefined for explicit empty responses including 204", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      apiFetch({
        method: "DELETE",
        path: "/api/projects/p1",
        responseMode: "empty",
      }),
    ).resolves.toBeUndefined();
  });

  it("cleans timeout and caller-signal listeners after completion", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const addSpy = vi.spyOn(caller.signal, "addEventListener");
    const removeSpy = vi.spyOn(caller.signal, "removeEventListener");
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch({
      method: "GET",
      path: "/api/ok",
      responseSchema: z.object({ ok: z.literal(true) }),
      timeoutMs: 100,
      signal: caller.signal,
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("supports FormData and custom headers without setting content-type", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const body = new FormData();
    body.append("file", new Blob(["x"]), "x.txt");

    await apiFetch({
      method: "POST",
      path: "/api/uploads",
      accessToken: "private-token",
      body,
      headers: { "x-request-id": "r1" },
      responseMode: "empty",
    });

    const [, init] = mockFetch.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer private-token");
    expect(headers.get("x-request-id")).toBe("r1");
    expect(headers.has("content-type")).toBe(false);
  });

  it("validates JSON request bodies before fetch", async () => {
    await expect(
      apiFetch({
        method: "POST",
        path: "/api/projects",
        requestSchema: z.object({ name: z.string().min(1) }),
        body: { name: "" },
        responseSchema: z.unknown(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ApiProtocolError",
        message: "API request payload is invalid",
      }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps access tokens in authorization headers rather than URLs", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch({
      method: "GET",
      path: "/api/ok",
      accessToken: "private-token",
      responseSchema: z.object({ ok: z.literal(true) }),
    });

    expect(String(mockFetch.mock.calls[0]?.[0])).not.toContain("private-token");
    expect(
      new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer private-token");
  });
});
