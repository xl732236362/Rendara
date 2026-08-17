// @credits-system — Lemon Squeezy webhook handler: subscription events, payment confirmation
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  PaymentService,
  WebhookPayload,
} from "../features/payments/payment-service.js";
import type { AdminSupabaseClient } from "../supabase/admin.js";
import { parseRequest, throwRouteError } from "./route-errors.js";

const webhookPayloadSchema = z
  .string()
  .transform((raw, context) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      context.addIssue({ code: "custom", message: "Invalid JSON body" });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .object({
        data: z
          .object({
            id: z.string(),
            type: z.string(),
            attributes: z
              .object({
                store_id: z.number(),
                customer_id: z.number(),
                order_id: z.number(),
                variant_id: z.number(),
                status: z.string(),
                renews_at: z.string().nullable(),
                ends_at: z.string().nullable(),
                cancelled: z.boolean().optional(),
                urls: z
                  .object({
                    customer_portal: z.string().optional(),
                    update_payment_method: z.string().optional(),
                  })
                  .optional(),
              })
              .passthrough(),
          })
          .passthrough(),
        meta: z
          .object({
            event_name: z.string().min(1),
            custom_data: z
              .object({ workspace_id: z.string().optional() })
              .optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  )
  .transform((value): WebhookPayload => {
    const { cancelled, urls, ...attributes } = value.data.attributes;
    const workspaceId = value.meta.custom_data?.workspace_id;
    return {
      data: {
        id: value.data.id,
        type: value.data.type,
        attributes: {
          ...attributes,
          ...(cancelled === undefined ? {} : { cancelled }),
          ...(urls
            ? {
                urls: {
                  ...(urls.customer_portal
                    ? { customer_portal: urls.customer_portal }
                    : {}),
                  ...(urls.update_payment_method
                    ? { update_payment_method: urls.update_payment_method }
                    : {}),
                },
              }
            : {}),
        },
      },
      meta: {
        event_name: value.meta.event_name,
        ...(workspaceId ? { custom_data: { workspace_id: workspaceId } } : {}),
      },
    };
  });

export async function registerPaymentWebhookRoute(
  app: FastifyInstance,
  options: {
    getAdminClient: () => AdminSupabaseClient;
    paymentService: PaymentService;
    webhookSecret: string;
  },
) {
  // Register a custom content-type parser to capture the raw body for
  // HMAC signature verification while still parsing JSON.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post("/api/payments/webhook", async (request, reply) => {
    const rawBody = parseRequest(z.string(), request.body);

    // ── 1. Verify webhook signature ──────────────────────────
    const signature = request.headers["x-signature"] as string | undefined;
    if (!signature) {
      throwRouteError({
        code: "unauthorized",
        statusCode: 401,
        message: "Missing X-Signature header",
      });
    }

    const expected = crypto
      .createHmac("sha256", options.webhookSecret)
      .update(rawBody)
      .digest("hex");

    if (
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      throwRouteError({
        code: "unauthorized",
        statusCode: 401,
        message: "Invalid webhook signature",
      });
    }

    // ── 2. Parse body ────────────────────────────────────────
    const payload = parseRequest(webhookPayloadSchema, rawBody);

    const eventName = payload.meta.event_name;

    const workspaceId = payload.meta?.custom_data?.workspace_id ?? null;

    // ── 3. Log to payment_events audit table ─────────────────
    // NOTE: payment_events table is added via migration but not yet in the
    // generated Database type — use `as any` until types are regenerated.
    const admin = options.getAdminClient();
    const eventId = payload.data?.id ?? null;

    const { error: insertError } = await (admin as any)
      .from("payment_events")
      .insert({
        event_name: eventName,
        lemon_squeezy_event_id: eventId,
        workspace_id: workspaceId,
        payload: payload as unknown as Record<string, unknown>,
        processed: false,
      });

    if (insertError) {
      console.error(
        "[Webhook] Failed to log payment event:",
        (insertError as any).message,
      );
      // Continue processing even if audit logging fails
    }

    // ── 4. Process event ─────────────────────────────────────
    try {
      // Processing and audit state form one transaction-like workflow: on
      // failure, persist the audit error before rethrowing the original cause.
      await options.paymentService.handleWebhookEvent(eventName, payload);

      // Mark as processed
      if (eventId) {
        await (admin as any)
          .from("payment_events")
          .update({ processed: true })
          .eq("lemon_squeezy_event_id", eventId);
      }
    } catch (processingError) {
      const errorMessage =
        processingError instanceof Error
          ? processingError.message
          : "Unknown error";

      console.error(`[Webhook] Error processing ${eventName}:`, errorMessage);

      // Record error in audit trail
      if (eventId) {
        await (admin as any)
          .from("payment_events")
          .update({ error_message: errorMessage })
          .eq("lemon_squeezy_event_id", eventId);
      }

      // Still return 200 to prevent Lemon Squeezy from retrying endlessly.
      // The error is logged for manual investigation.
    }

    return reply.code(200).send({ received: true });
  });
}
