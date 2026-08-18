import type { StructuredTool } from "@langchain/core/tools";

import type { ApplyCanvasOperations } from "../../application/canvas/apply-canvas-operations.js";
import type { ProviderCatalog } from "../../generation/providers/registry.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
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
}) {
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
  if (deps.applyCanvasOperations && deps.resolveWorkspaceId) {
    tools.push(
      createManipulateCanvasTool({
        applyCanvasOperations: deps.applyCanvasOperations,
        resolveWorkspaceId: deps.resolveWorkspaceId,
      }),
    );
  }
  if (deps.brandKitId) {
    tools.push(createBrandKitTool(deps, deps.brandKitId));
  }
  if (deps.connectionManager) {
    tools.push(
      createScreenshotCanvasTool({
        connectionManager: deps.connectionManager,
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
