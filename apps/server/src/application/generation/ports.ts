import type {
  BackgroundJobStatus,
  BackgroundJobType,
  GenerationSubmissionRequest,
  SubscriptionPlan,
} from "@loomic/shared";

export type GenerationPrincipal = {
  userId: string;
  workspaceId: string;
  accessToken?: string;
};

export type AgentAttachmentPlacement =
  | { kind: "auto_right" }
  | {
      kind: "explicit";
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      kind: "relative";
      elementId: string;
      relation: "above" | "below" | "left" | "right";
      gap: number;
      maxWidth?: number;
      maxHeight?: number;
    };

export type AgentAttachmentContext = {
  intentId: string;
  runId: string;
  attemptId: string;
  fencingToken: number;
  logicalToolCallId: string;
  inputDigest: string;
  effectKind: "generated_asset_attached";
  mediaType: "image" | "video";
  placement: AgentAttachmentPlacement;
};

export type AtomicJobSubmissionCommand = {
  principal: GenerationPrincipal;
  workspaceId: string;
  projectId?: string;
  canvasId?: string;
  sessionId?: string;
  threadId?: string;
  jobType: BackgroundJobType;
  idempotencyKey: string;
  requestFingerprint: string;
  creditsCost: number;
  description: string;
  payload: Record<string, unknown>;
  attachmentIntent?: AgentAttachmentContext;
};

export type GenerationSubmissionOutcome = {
  id: string;
  status: BackgroundJobStatus;
  replayed: boolean;
};

export type GenerationCancellationOutcome = {
  id: string;
  status: "canceled" | "canceling";
};

export type GenerationJobSubmissionPort = {
  submit(
    command: AtomicJobSubmissionCommand,
  ): Promise<GenerationSubmissionOutcome>;
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

export type CreditBalancePort = {
  getBalance(workspaceId: string): Promise<{
    balance: number;
    plan: SubscriptionPlan;
    dailyClaimed: boolean;
  }>;
};

export type ReferenceAssetAuthorizationPort = {
  authorize(input: {
    principal: GenerationPrincipal;
    projectId: string;
    assetIds: string[];
  }): Promise<void>;
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
  credits?: CreditBalancePort;
  referenceAssets?: ReferenceAssetAuthorizationPort;
  attachmentIntents?: {
    isReady(): boolean;
  };
};
