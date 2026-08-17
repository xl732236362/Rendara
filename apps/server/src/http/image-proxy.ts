import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  SafeFetchError,
  type SafeFetchResult,
} from "../security/safe-fetch.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { parseRequest, throwRouteError } from "./route-errors.js";

const imageProxyQuerySchema = z.object({ url: z.string().min(1) });

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
        throwRouteError({
          code: "unauthorized",
          statusCode: 401,
          message: "Authentication required.",
        });
      }

      const { url } = parseRequest(imageProxyQuerySchema, request.query);

      try {
        // SafeFetchError carries transport-neutral security codes but no HTTP
        // status; this adapter translation is intentionally route-specific.
        const result = await options.safeFetch(url);
        return reply
          .header("content-type", result.contentType)
          .header("cache-control", "private, max-age=86400")
          .send(result.body);
      } catch (error) {
        if (error instanceof SafeFetchError) {
          throwRouteError({
            code: error.code,
            statusCode: safeFetchStatus(error.code),
            message: "The requested image could not be fetched safely.",
          });
        }

        request.log.error({ err: error }, "image proxy fetch failed");
        throwRouteError({
          code: "upstream_error",
          statusCode: 502,
          message: "The requested image could not be fetched.",
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
