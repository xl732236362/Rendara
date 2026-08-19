import type { StructuredTool } from "@langchain/core/tools";

import type { ApplyCanvasOperations } from "../../application/canvas/apply-canvas-operations.js";
import type { AgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";
import type { ProviderCatalog } from "../../generation/providers/registry.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { BuiltinSkillCatalog } from "../builtin-skills/catalog.js";
import { createBuiltinSkillReadTool } from "../builtin-skills/read-tool.js";
import type { AgentExecutionContext } from "../execution-context.js";
import { createBrandKitTool } from "./brand-kit.js";
import {
  type PersistImageFn,
  type SubmitImageJobFn,
  createImageGenerateTool,
} from "./image-generate.js";
import { createInspectCanvasTool } from "./inspect-canvas.js";
import { createManipulateCanvasTool } from "./manipulate-canvas.js";
import { createScreenshotCanvasTool } from "./screenshot-canvas.js";
import {
  type SubmitVideoJobFn,
  createVideoGenerateTool,
} from "./video-generate.js";

export { createImageGenerateTool } from "./image-generate.js";
export { createVideoGenerateTool } from "./video-generate.js";
export { createInspectCanvasTool } from "./inspect-canvas.js";
export { createManipulateCanvasTool } from "./manipulate-canvas.js";

export function createMainAgentTools(deps: {
  createUserClient: (accessToken: string) => any;
  applyCanvasOperations?: ApplyCanvasOperations;
  resolveWorkspaceId?: (context: {
    accessToken: string;
    userId: string;
    canvasId: string;
  }) => Promise<string>;
  brandKitId?: string | null;
  connectionManager?: ConnectionManager;
  persistImage?: PersistImageFn;
  providerRegistry: ProviderCatalog;
  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  executionContext?: AgentExecutionContext;
  builtinSkillCatalog?: BuiltinSkillCatalog;
  agentExecutionRepository?: AgentExecutionRepository;
  fencingToken?: number;
  authorizeExecutionContext?: () => Promise<void>;
  resolveCurrentCapabilities?: () => readonly AgentExecutionContext["capabilities"][number][];
}) {
  if (
    !deps.executionContext ||
    !deps.agentExecutionRepository ||
    deps.fencingToken === undefined
  ) {
    throw new Error("persisted_agent_authority_required");
  }
  const tools: StructuredTool[] = [
    createInspectCanvasTool(deps),
    createImageGenerateTool({
      providerRegistry: deps.providerRegistry,
      ...(deps.persistImage ? { persistImage: deps.persistImage } : {}),
      ...(deps.submitImageJob ? { submitImageJob: deps.submitImageJob } : {}),
    }),
    createVideoGenerateTool({
      providerRegistry: deps.providerRegistry,
      ...(deps.submitVideoJob ? { submitVideoJob: deps.submitVideoJob } : {}),
    }),
  ];
  if (
    deps.executionContext &&
    deps.builtinSkillCatalog &&
    deps.agentExecutionRepository
  ) {
    tools.push(
      createBuiltinSkillReadTool({
        catalog: deps.builtinSkillCatalog,
        context: deps.executionContext,
        repository: deps.agentExecutionRepository,
      }),
    );
  }
  if (deps.applyCanvasOperations && deps.resolveWorkspaceId) {
    tools.push(
      createManipulateCanvasTool({
        applyCanvasOperations: deps.applyCanvasOperations,
        resolveWorkspaceId: deps.resolveWorkspaceId,
        agentEffect: {
          runId: deps.executionContext.runId,
          attemptId: deps.executionContext.attemptId,
          fencingToken: deps.fencingToken,
        },
      }),
    );
  }
  if (deps.executionContext.capabilities.includes("brand_kit.read")) {
    tools.push(createBrandKitTool(deps, deps.brandKitId));
  }
  if (deps.connectionManager) {
    tools.push(
      createScreenshotCanvasTool({
        connectionManager: deps.connectionManager,
        ...(deps.executionContext
          ? {
              canvasId: deps.executionContext.canvasId,
              userId: deps.executionContext.userId,
            }
          : {}),
        ...(deps.persistImage ? { persistImage: deps.persistImage } : {}),
      }),
    );
  }
  return tools;
}

/** @deprecated Use createMainAgentTools + sub-agents instead */
export function createPhaseATools(providerRegistry: ProviderCatalog) {
  return [
    createImageGenerateTool({ providerRegistry }),
    createVideoGenerateTool({ providerRegistry }),
  ] as const;
}
