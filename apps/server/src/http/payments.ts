import {
  applicationErrorResponseSchema,
  billingPeriodSchema,
  subscriptionPlanSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
// @credits-system — Payment API routes: checkout, subscription status, plan change, cancellation
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type PaymentService,
  PaymentServiceError,
} from "../features/payments/payment-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  parseRequest,
  raiseBoundaryError,
  throwLegacyServiceError,
} from "./route-errors.js";

const paymentPlanRequestSchema = z.object({
  plan: subscriptionPlanSchema,
  billingPeriod: billingPeriodSchema,
});

export async function registerPaymentRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    paymentService: PaymentService;
    viewerService: ViewerService;
  },
) {
  // POST /api/payments/checkout — create a checkout session
  app.post("/api/payments/checkout", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const body = parseRequest(paymentPlanRequestSchema, request.body);

    if (body.plan === "free") {
      return raiseBoundaryError(
        {
          error: {
            code: "invalid_request",
            message: "Cannot create a checkout for the free plan.",
          },
        },
        400,
      );
    }

    const viewer = await options.viewerService.ensureViewer(user);
    const result = await options.paymentService.createCheckout(
      viewer.workspace.id,
      body.plan,
      body.billingPeriod,
    );

    return reply.code(200).send({ checkoutUrl: result.checkoutUrl });
  });

  // GET /api/payments/subscription — get current subscription status
  app.get("/api/payments/subscription", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const viewer = await options.viewerService.ensureViewer(user);
    const status = await options.paymentService.getSubscriptionStatus(
      viewer.workspace.id,
    );

    return reply.code(200).send(status);
  });

  // POST /api/payments/cancel — cancel subscription at period end
  app.post("/api/payments/cancel", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const viewer = await options.viewerService.ensureViewer(user);
    await options.paymentService.cancelSubscription(viewer.workspace.id);

    return reply.code(200).send({ success: true });
  });

  // POST /api/payments/change-plan — change to a different plan
  app.post("/api/payments/change-plan", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const body = parseRequest(paymentPlanRequestSchema, request.body);

    if (body.plan === "free") {
      return raiseBoundaryError(
        {
          error: {
            code: "invalid_request",
            message: "Cannot change to the free plan. Use cancel instead.",
          },
        },
        400,
      );
    }

    const viewer = await options.viewerService.ensureViewer(user);
    await options.paymentService.changePlan(
      viewer.workspace.id,
      body.plan,
      body.billingPeriod,
    );

    return reply.code(200).send({ success: true });
  });
}

// ── Helpers ──────────────────────────────────────────────────

function sendUnauthenticated(reply: FastifyReply) {
  return raiseBoundaryError(
    {
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    },
    401,
  );
}

type PaymentErrorFallbackCode =
  | "checkout_failed"
  | "subscription_not_found"
  | "subscription_update_failed";
