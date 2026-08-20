import { randomUUID } from "node:crypto";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { ToolMessage } from "@langchain/core/messages";
import { isGraphBubbleUp } from "@langchain/langgraph";
import { ToolInvocationError, createMiddleware } from "langchain";
import { z } from "zod";

import {
  generatedAssetRecoverySchema,
  toolArtifactSchema,
} from "@loomic/shared";
import type { AgentExecutionRepository } from "../features/agent-runs/agent-execution-repository.js";
import type { AgentCapability } from "./capabilities.js";
import type { AgentExecutionContext } from "./execution-context.js";
import { GeneratedAssetAttachmentError } from "./generated-media-result.js";
import type { ToolExecutionSupervisor } from "./tool-execution-supervisor.js";
import {
  type CanonicalToolRecord,
  canonicalInputDigest,
} from "./tool-lifecycle.js";
import {
  assertActiveToolAuthority,
  assertBoundedToolInput,
  assertBoundedToolResult,
} from "./tools/tool-guard.js";

const recoverableToolErrorSchema = z
  .object({
    type: z.literal("loomic.tool_error"),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
    correlationId: z.string().min(1),
    recovery: generatedAssetRecoverySchema.optional(),
    artifacts: z.array(toolArtifactSchema).max(10).optional(),
  })
  .strict();

const TOOL_CAPABILITIES = Object.freeze({
  read_builtin_skill: "skill.read",
  inspect_canvas: "canvas.read",
  screenshot_canvas: "canvas.read",
  manipulate_canvas: "canvas.mutate",
  generate_image: "image.generate",
  generate_video: "video.generate",
  get_brand_kit: "brand_kit.read",
  project_search: "project.search",
  task: "agent.delegate",
} satisfies Readonly<Record<string, AgentCapability>>);

type GovernanceDependencies = {
  readonly context: AgentExecutionContext;
  readonly fencingToken: number;
  readonly repository: AgentExecutionRepository;
  readonly supervisor: ToolExecutionSupervisor;
  readonly publish?: (record: CanonicalToolRecord) => Promise<void>;
  readonly authorize?: () => Promise<void>;
  readonly resolveCurrentCapabilities?: () => readonly AgentCapability[];
  readonly acknowledgementTimeoutMs?: number;
};

export class LoomicToolBoundaryError extends Error {
  readonly loomicToolBoundary = true;
  readonly classification: string;
  readonly correlationId: string;
  readonly publicationFailure: string | undefined;

  constructor(options: {
    cause: unknown;
    classification: string;
    correlationId: string;
    publicationFailure?: string;
  }) {
    super("Agent tool execution failed.", { cause: options.cause });
    this.name = "LoomicToolBoundaryError";
    this.classification = options.classification;
    this.correlationId = options.correlationId;
    this.publicationFailure = options.publicationFailure;
  }
}

export function isLoomicToolBoundaryError(
  error: unknown,
): error is LoomicToolBoundaryError {
  return (
    error instanceof LoomicToolBoundaryError &&
    error.loomicToolBoundary === true
  );
}

export function requiredCapabilityForToolName(
  toolName: string,
): AgentCapability {
  const capability = (
    TOOL_CAPABILITIES as Readonly<Record<string, AgentCapability>>
  )[toolName];
  if (!capability) throw new Error("unclassified_agent_tool");
  return capability;
}

export function createToolGovernanceMiddleware(
  dependencies: GovernanceDependencies,
) {
  const publish =
    dependencies.publish ??
    (async (record: CanonicalToolRecord) => {
      await dispatchCustomEvent(record.type, record);
    });

  async function publishAndWait(record: CanonicalToolRecord) {
    await publish(record);
    await dependencies.supervisor.waitForAcknowledgement(record, {
      ...(dependencies.acknowledgementTimeoutMs !== undefined
        ? { timeoutMs: dependencies.acknowledgementTimeoutMs }
        : {}),
    });
  }

  return createMiddleware({
    name: "LoomicToolGovernance",
    wrapToolCall: async (request, handler) => {
      const { id: logicalToolCallId, name: toolName, args } = request.toolCall;
      if (typeof logicalToolCallId !== "string" || !logicalToolCallId) {
        throw new Error("tool_call_id_required");
      }
      assertBoundedToolInput(args);

      const inputDigest = canonicalInputDigest(args);
      const started = dependencies.supervisor.stageStart({
        logicalToolCallId,
        toolName,
        inputDigest,
        ...(isRecord(args) ? { input: args } : {}),
      });
      await publishAndWait(started);

      const correlationId = randomUUID();
      try {
        if (request.tool) {
          await assertAuthority(
            dependencies,
            requiredCapabilityForToolName(toolName),
          );
        }

        const result = await handler(request);

        if (request.tool) {
          await assertAuthority(
            dependencies,
            requiredCapabilityForToolName(toolName),
          );
        }
        assertBoundedToolResult(result);
        assertToolMessageIdentity(result, logicalToolCallId, toolName);

        if (ToolMessage.isInstance(result) && result.status === "error") {
          const recoverable = recoverableToolErrorSchema.parse(result.artifact);
          const failed = dependencies.supervisor.stageFailed(
            logicalToolCallId,
            {
              code: recoverable.code,
              message: recoverable.message,
              correlationId: recoverable.correlationId,
            },
            {
              ...(recoverable.recovery
                ? { recovery: recoverable.recovery }
                : {}),
              ...(recoverable.artifacts
                ? { artifacts: recoverable.artifacts }
                : {}),
            },
          );
          await publishAndWait(failed);
          return result;
        }

        const completed = dependencies.supervisor.stageCompleted(
          logicalToolCallId,
          summarizeResult(result),
        );
        await publishAndWait(completed);
        return result;
      } catch (cause) {
        if (isGraphBubbleUp(cause)) throw cause;
        if (cause instanceof GeneratedAssetAttachmentError) {
          const { error, recovery, artifact } = cause.result;
          const artifacts = artifact ? [artifact] : undefined;
          const failed = dependencies.supervisor.stageFailed(
            logicalToolCallId,
            {
              code: error.code,
              message: error.message,
              correlationId,
            },
            { recovery, ...(artifacts ? { artifacts } : {}) },
          );
          await publishAndWait(failed);
          return new ToolMessage({
            content: error.message,
            name: toolName,
            status: "error",
            tool_call_id: logicalToolCallId,
            artifact: {
              type: "loomic.tool_error",
              code: error.code,
              message: error.message,
              correlationId,
              recovery,
              ...(artifacts ? { artifacts } : {}),
            },
          });
        }
        if (cause instanceof ToolInvocationError) {
          const recoverable = {
            code: "invalid_arguments",
            message: "Check the tool arguments and try again.",
            correlationId,
          };
          const failed = dependencies.supervisor.stageFailed(
            logicalToolCallId,
            recoverable,
          );
          await publishAndWait(failed);
          return new ToolMessage({
            content: recoverable.message,
            name: toolName,
            status: "error",
            tool_call_id: logicalToolCallId,
            artifact: { type: "loomic.tool_error", ...recoverable },
          });
        }

        let publicationFailure: string | undefined;
        if (dependencies.supervisor.callState(logicalToolCallId) === "open") {
          try {
            const failed = dependencies.supervisor.stageFailed(
              logicalToolCallId,
              {
                code: "tool_failed",
                message: "The tool could not complete.",
                correlationId,
              },
            );
            await publishAndWait(failed);
          } catch (failureCause) {
            publicationFailure = boundedErrorName(failureCause);
          }
        }
        throw new LoomicToolBoundaryError({
          cause,
          classification: classifyFailure(cause),
          correlationId,
          ...(publicationFailure ? { publicationFailure } : {}),
        });
      }
    },
  });
}

async function assertAuthority(
  dependencies: GovernanceDependencies,
  capability: AgentCapability,
) {
  await assertActiveToolAuthority({
    capability,
    context: dependencies.context,
    repository: dependencies.repository,
    fencingToken: dependencies.fencingToken,
    ...(dependencies.resolveCurrentCapabilities
      ? {
          resolveCurrentCapabilities: dependencies.resolveCurrentCapabilities,
        }
      : {}),
  });
  await dependencies.authorize?.();
}

function assertToolMessageIdentity(
  result: unknown,
  logicalToolCallId: string,
  toolName: string,
) {
  if (!ToolMessage.isInstance(result)) return;
  if (
    result.tool_call_id !== logicalToolCallId ||
    (result.name !== undefined && result.name !== toolName)
  ) {
    throw new Error("tool_result_identity_conflict");
  }
}

function summarizeResult(result: unknown) {
  if (!ToolMessage.isInstance(result) || typeof result.content !== "string") {
    return {};
  }
  return { outputSummary: result.content.slice(0, 512) };
}

function classifyFailure(error: unknown): string {
  if (error instanceof Error && error.message === "run_not_active") {
    return "run_not_active";
  }
  if (error instanceof Error && error.message === "capability_denied") {
    return "capability_denied";
  }
  return "tool_execution_failed";
}

function boundedErrorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : "UnknownError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
