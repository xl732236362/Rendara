import { describe, expect, it } from "vitest";

import { type SafeFetchPolicy, safeFetch } from "./safe-fetch.js";

const imagePolicy: SafeFetchPolicy = {
  allowedHosts: ["replicate.delivery"],
  allowedMimeTypes: [/^image\//i],
  maxBytes: 8,
  maxRedirects: 2,
  timeoutMs: 1_000,
};

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

describe("safeFetch", () => {
  it.each([
    "http://replicate.delivery/a.png",
    "https://127.0.0.1/a.png",
    "https://[::1]/a.png",
    "https://169.254.169.254/latest/meta-data",
    "https://evilreplicate.delivery/a.png",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(
      safeFetch(url, imagePolicy, {
        fetch: async () => new Response(),
        resolve: publicResolver,
      }),
    ).rejects.toMatchObject({ code: "unsafe_url" });
  });

  it("rejects an allowed hostname when DNS resolves to a private address", async () => {
    await expect(
      safeFetch("https://replicate.delivery/a.png", imagePolicy, {
        fetch: async () => new Response(),
        resolve: async () => [{ address: "10.0.0.8", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "unsafe_url" });
  });

  it("revalidates every redirect target", async () => {
    await expect(
      safeFetch("https://replicate.delivery/a.png", imagePolicy, {
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://127.0.0.1/internal" },
          }),
        resolve: publicResolver,
      }),
    ).rejects.toMatchObject({ code: "unsafe_url" });
  });

  it("rejects responses with an unexpected MIME type", async () => {
    await expect(
      safeFetch("https://replicate.delivery/a.png", imagePolicy, {
        fetch: async () =>
          new Response("html", {
            headers: { "content-type": "text/html" },
          }),
        resolve: publicResolver,
      }),
    ).rejects.toMatchObject({ code: "invalid_content_type" });
  });

  it("stops reading when the response exceeds the byte budget", async () => {
    await expect(
      safeFetch("https://replicate.delivery/a.png", imagePolicy, {
        fetch: async () =>
          new Response("123456789", {
            headers: { "content-type": "image/png" },
          }),
        resolve: publicResolver,
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("aborts an upstream request after the configured timeout", async () => {
    await expect(
      safeFetch(
        "https://replicate.delivery/a.png",
        { ...imagePolicy, timeoutMs: 5 },
        {
          fetch: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            }),
          resolve: publicResolver,
        },
      ),
    ).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("returns a bounded valid response from an exact subdomain", async () => {
    const result = await safeFetch(
      "https://pbxt.replicate.delivery/a.png",
      imagePolicy,
      {
        fetch: async () =>
          new Response("image", {
            headers: { "content-type": "image/png" },
          }),
        resolve: publicResolver,
      },
    );

    expect(result.body.toString()).toBe("image");
    expect(result.contentType).toBe("image/png");
    expect(result.finalUrl.hostname).toBe("pbxt.replicate.delivery");
  });
});
