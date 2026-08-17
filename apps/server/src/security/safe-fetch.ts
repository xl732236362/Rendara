import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SafeFetchPolicy = {
  allowedHosts: readonly string[];
  allowedMimeTypes: readonly RegExp[];
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
};

export type SafeFetchResult = {
  body: Buffer;
  contentType: string;
  finalUrl: URL;
};

export class SafeFetchError extends Error {
  constructor(
    readonly code:
      | "unsafe_url"
      | "upstream_error"
      | "invalid_content_type"
      | "response_too_large"
      | "request_timeout",
    message: string,
  ) {
    super(message);
  }
}

type SafeFetchDependencies = {
  fetch: typeof fetch;
  resolve: (
    hostname: string,
  ) => Promise<readonly { address: string; family: number }[]>;
};

const defaultDependencies: SafeFetchDependencies = {
  fetch,
  resolve: async (hostname) => lookup(hostname, { all: true }),
};

export async function safeFetch(
  input: string | URL,
  policy: SafeFetchPolicy,
  dependencies: SafeFetchDependencies = defaultDependencies,
): Promise<SafeFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);

  try {
    let currentUrl = toSafeUrl(input);

    for (let redirects = 0; ; redirects += 1) {
      await validateUrl(currentUrl, policy, dependencies.resolve);

      let response: Response;
      try {
        response = await dependencies.fetch(currentUrl, {
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SafeFetchError(
            "request_timeout",
            "Upstream request timed out.",
          );
        }
        throw new SafeFetchError("upstream_error", "Upstream request failed.");
      }

      if (isRedirect(response.status)) {
        if (redirects >= policy.maxRedirects) {
          throw new SafeFetchError("unsafe_url", "Too many redirects.");
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new SafeFetchError(
            "upstream_error",
            "Redirect has no location.",
          );
        }
        currentUrl = toSafeUrl(new URL(location, currentUrl));
        continue;
      }

      if (!response.ok) {
        throw new SafeFetchError(
          "upstream_error",
          "Upstream returned an error.",
        );
      }

      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim();
      if (
        !contentType ||
        !policy.allowedMimeTypes.some((pattern) => pattern.test(contentType))
      ) {
        throw new SafeFetchError(
          "invalid_content_type",
          "Upstream content type is not allowed.",
        );
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > policy.maxBytes) {
        throw new SafeFetchError(
          "response_too_large",
          "Upstream response exceeds the byte budget.",
        );
      }

      const body = await readBoundedBody(response, policy.maxBytes);
      return { body, contentType, finalUrl: currentUrl };
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function validateUrl(
  url: URL,
  policy: SafeFetchPolicy,
  resolve: SafeFetchDependencies["resolve"],
) {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new SafeFetchError(
      "unsafe_url",
      "Only credential-free HTTPS URLs are allowed.",
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowed = policy.allowedHosts.some((candidate) => {
    const suffix = candidate.toLowerCase();
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
  if (!allowed || isIP(hostname)) {
    throw new SafeFetchError("unsafe_url", "Upstream host is not allowed.");
  }

  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new SafeFetchError(
      "unsafe_url",
      "Upstream host could not be resolved.",
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicIp(address))
  ) {
    throw new SafeFetchError(
      "unsafe_url",
      "Upstream host resolves to a private address.",
    );
  }
}

async function readBoundedBody(response: Response, maxBytes: number) {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SafeFetchError(
          "response_too_large",
          "Upstream response exceeds the byte budget.",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function toSafeUrl(input: string | URL) {
  try {
    return new URL(input);
  } catch {
    throw new SafeFetchError("unsafe_url", "Invalid upstream URL.");
  }
}

function isRedirect(status: number) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function isPublicIp(address: string) {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 6) {
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:")
    );
  }

  if (isIP(normalized) !== 4) return false;
  const [a = 0, b = 0] = normalized.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
