// @credits-system — Credit API routes: balance, transactions, daily claim, admin plan override
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  PLAN_CONFIGS,
  applicationErrorResponseSchema,
  claimDailyResponseSchema,
  createCursorPageSchema,
  creditBalanceResponseSchema,
  creditTransactionSchema,
  creditTransactionsResponseSchema,
  paginationQuerySchema,
  setPlanRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type CreditService,
  CreditServiceError,
} from "../features/credits/credit-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  parseRequest,
  raiseBoundaryError,
  throwLegacyServiceError,
} from "./route-errors.js";

const creditTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const creditTransactionPageSchema = createCursorPageSchema(
  creditTransactionSchema,
);

export async function registerCreditRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/v2/credits/transactions", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const query = parseRequest(paginationQuerySchema, request.query);
    const viewer = await options.viewerService.ensureViewer(user);
    const page = await options.creditService.listTransactionsPage(
      viewer.workspace.id,
      user.id,
      query,
    );
    return reply.code(200).send(creditTransactionPageSchema.parse(page));
  });

  // GET /api/credits — balance info
  app.get("/api/credits", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const viewer = await options.viewerService.ensureViewer(user);
    const balance = await options.creditService.getBalance(viewer.workspace.id);
    const config = PLAN_CONFIGS[balance.plan];

    return reply.code(200).send(
      creditBalanceResponseSchema.parse({
        balance: balance.balance,
        plan: balance.plan,
        dailyClaimed: balance.dailyClaimed,
        limits: {
          maxConcurrentJobs: config.maxConcurrentJobs,
          maxResolution: config.maxResolution,
          monthlyCredits: config.monthlyCredits,
          dailyCredits: config.dailyCredits,
        },
      }),
    );
  });

  // GET /api/credits/transactions — recent transactions
  app.get("/api/credits/transactions", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const viewer = await options.viewerService.ensureViewer(user);
    const { limit } = parseRequest(
      creditTransactionsQuerySchema,
      request.query,
    );

    const transactions = await options.creditService.getTransactions(
      viewer.workspace.id,
      limit,
    );

    return reply
      .code(200)
      .send(creditTransactionsResponseSchema.parse({ transactions }));
  });

  // POST /api/credits/claim-daily — claim daily free credits
  app.post("/api/credits/claim-daily", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const viewer = await options.viewerService.ensureViewer(user);
    const result = await options.creditService.claimDailyCredits(
      viewer.workspace.id,
    );

    if (!result.success) {
      return reply.code(200).send(
        claimDailyResponseSchema.parse({
          success: false,
          message:
            "Daily credits already claimed or not available for your plan.",
        }),
      );
    }

    return reply.code(200).send(
      claimDailyResponseSchema.parse({
        success: true,
        balance: result.balance,
      }),
    );
  });

  // POST /api/credits/admin/set-plan — dev-only plan change
  app.post("/api/credits/admin/set-plan", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const body = parseRequest(setPlanRequestSchema, request.body);
    const viewer = await options.viewerService.ensureViewer(user);

    await options.creditService.updatePlan(viewer.workspace.id, body.plan);

    // Return refreshed balance info
    const balance = await options.creditService.getBalance(viewer.workspace.id);
    const config = PLAN_CONFIGS[balance.plan];

    return reply.code(200).send(
      creditBalanceResponseSchema.parse({
        balance: balance.balance,
        plan: balance.plan,
        dailyClaimed: balance.dailyClaimed,
        limits: {
          maxConcurrentJobs: config.maxConcurrentJobs,
          maxResolution: config.maxResolution,
          monthlyCredits: config.monthlyCredits,
          dailyCredits: config.dailyCredits,
        },
      }),
    );
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

type CreditErrorFallbackCode =
  | "credit_query_failed"
  | "credit_claim_failed"
  | "credit_deduct_failed"
  | "credit_refund_failed"
  | "credit_plan_update_failed";
