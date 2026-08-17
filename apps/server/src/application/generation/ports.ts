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

export type GenerationSubmissionOutcome = {
  id: string;
  status: "queued";
};

export type GenerationCancellationOutcome = {
  id: string;
  status: "canceled" | "canceling";
};

export type GenerationJobSubmissionPort = {
  create(command: JobCreateCommand): Promise<GenerationSubmissionOutcome>;
  attachCredits(
    jobId: string,
    creditsCost: number,
    transactionId: string,
  ): Promise<void>;
};

export type GenerationCancellationPort = {
  /** The adapter enforces ownership and cancellable status atomically. */
  cancel(
    principal: GenerationPrincipal,
    jobId: string,
  ): Promise<GenerationCancellationOutcome>;
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

export type CreditDeductionPort = {
  deduct(command: {
    workspaceId: string;
    userId: string;
    amount: number;
    jobId: string;
    description: string;
  }): Promise<string>;
};

export type StructuredLogContext = Record<string, unknown>;

export type StructuredLogger = {
  info(message: string, context: StructuredLogContext): void;
  warn(message: string, context: StructuredLogContext): void;
  error(message: string, context: StructuredLogContext): void;
};

export type GenerationApplicationPorts = {
  jobs: GenerationJobSubmissionPort;
  cancellation: GenerationCancellationPort;
  models: ModelCatalogPort;
  tiers: TierAuthorizationPort;
  credits?: CreditDeductionPort;
};
