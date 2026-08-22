// @credits-system — Image model list with tier annotations, credit costs, and accessibility flags
import type { FastifyInstance } from "fastify";

import {
  MODEL_MIN_TIER,
  type SubscriptionPlan,
  canAccessModel,
  getImageCreditCost,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { ProviderCatalog } from "../generation/providers/registry.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export const IMAGE_MODEL_CATALOG_MAX_ITEMS = 100;

export async function registerImageModelRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    providerRegistry: ProviderCatalog;
    viewerService: ViewerService;
  },
) {
  app.get("/api/image-models", async (request, reply) => {
    const models = options.providerRegistry.getAvailableImageModels();

    // Try to authenticate — unauthenticated users still see models
    let userPlan: SubscriptionPlan | null = null;
    try {
      // Public catalog access must survive optional authentication/plan
      // enrichment failures; models are conservatively marked inaccessible.
      const user = await options.auth.authenticate(request);
      if (user) {
        const viewer = await options.viewerService.ensureViewer(user);
        const balance = await options.creditService.getBalance(
          viewer.workspace.id,
        );
        userPlan = balance.plan;
      }
    } catch {
      // Auth failure is non-fatal — just show models as inaccessible
    }

    const annotated = models
      .slice(0, IMAGE_MODEL_CATALOG_MAX_ITEMS)
      .map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        iconUrl: m.iconUrl,
        provider: m.provider,
        accessible: userPlan !== null && canAccessModel(userPlan, m.id),
        creditCost: getImageCreditCost(m.id, "hd"),
        minTier: MODEL_MIN_TIER[m.id] ?? "pro",
      }));

    return reply.code(200).send({ models: annotated });
  });
}
