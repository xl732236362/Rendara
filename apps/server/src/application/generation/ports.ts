import type {
  BackgroundJobType,
  GenerationSubmissionRequest,
  SubscriptionPlan,
} from "@loomic/shared";

export type GenerationPrincipal = {
  userId: string;
  workspaceId: string;
  accessToken?: string;
};

export type JobCreateCommand = {
  principal: GenerationPrincipal;
  workspaceId: string;
  projectId?: string;
  canvasId?: string;
  sessionId?: string;
  threadId?: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
};

export type GenerationJob = {
  id: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "canceled"
    | "dead_letter";
};

export type JobPort = {
  create(command: JobCreateCommand): Promise<GenerationJob>;
  cancel(principal: GenerationPrincipal, jobId: string): Promise<GenerationJob>;
  attachCredits(
    jobId: string,
    creditsCost: number,
    transactionId: string,
  ): Promise<void>;
};

export type ModelCatalogPort = {
  /** Resolves defaults and rejects models that do not exist for this media type. */
  resolveModel(type: BackgroundJobType, requestedModel?: string): string;
};

export type TierAuthorizationPort = {
  getPlan(workspaceId: string): Promise<SubscriptionPlan>;
  authorizeModel(plan: SubscriptionPlan, modelId: string): void;
  authorizeMedia(
    plan: SubscriptionPlan,
    request: GenerationSubmissionRequest,
  ): void;
  authorizeConcurrency(
    workspaceId: string,
    plan: SubscriptionPlan,
  ): Promise<void>;
  calculateCreditCost(
    modelId: string,
    request: GenerationSubmissionRequest,
  ): number;
};

export type CreditPort = {
  deduct(command: {
    workspaceId: string;
    userId: string;
    amount: number;
    jobId: string;
    description: string;
  }): Promise<string>;
  /** Reserved for workflows that already refund; submission keeps current cancel-only semantics. */
  refund(command: {
    workspaceId: string;
    userId: string;
    amount: number;
    jobId: string;
    description: string;
  }): Promise<string | undefined>;
};

export type StructuredLogContext = Record<string, unknown>;

export type StructuredLogger = {
  info(message: string, context: StructuredLogContext): void;
  warn(message: string, context: StructuredLogContext): void;
  error(message: string, context: StructuredLogContext): void;
};

export type GenerationApplicationPorts = {
  jobs: JobPort;
  models: ModelCatalogPort;
  tiers: TierAuthorizationPort;
  credits?: CreditPort;
};
