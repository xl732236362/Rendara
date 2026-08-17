import type { FastifyInstance } from "fastify";

import {
  SafeFetchError,
  type SafeFetchResult,
} from "../security/safe-fetch.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export type ImageSafeFetcher = (url: string) => Promise<SafeFetchResult>;

export async function registerImageProxyRoute(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    safeFetch: ImageSafeFetcher;
  },
) {
  app.get<{ Querystring: { url?: string } }>(
    "/api/proxy-image",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) {
        return reply.code(401).send({
          error: { code: "unauthorized", message: "Authentication required." },
        });
      }

      const { url } = request.query;
      if (!url || typeof url !== "string") {
        return reply.code(400).send({
          error: {
            code: "invalid_request",
            message: "A valid URL is required.",
          },
        });
      }

      try {
        const result = await options.safeFetch(url);
        return reply
          .header("content-type", result.contentType)
          .header("cache-control", "private, max-age=86400")
          .send(result.body);
      } catch (error) {
        if (error instanceof SafeFetchError) {
          return reply.code(safeFetchStatus(error.code)).send({
            error: {
              code: error.code,
              message: "The requested image could not be fetched safely.",
            },
          });
        }

        request.log.error({ err: error }, "image proxy fetch failed");
        return reply.code(502).send({
          error: {
            code: "upstream_error",
            message: "The requested image could not be fetched.",
          },
        });
      }
    },
  );
}

function safeFetchStatus(code: SafeFetchError["code"]) {
  if (code === "unsafe_url") return 403;
  if (code === "response_too_large") return 413;
  if (code === "invalid_content_type") return 415;
  if (code === "request_timeout") return 504;
  return 502;
}
