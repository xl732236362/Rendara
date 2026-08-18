import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatVertexAI } from "@langchain/google-vertexai";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import { ChatOpenAI } from "@langchain/openai";

import type { ApplyCanvasOperations } from "../application/canvas/apply-canvas-operations.js";
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_GOOGLE_AGENT_MODEL,
  type ServerEnv,
} from "../config/env.js";
import type { AgentExecutionRepository } from "../features/agent-runs/agent-execution-repository.js";
import type { ProviderCatalog } from "../generation/providers/registry.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import { type ExactAgent, createExactLoomicAgent } from "./agent-factory.js";
import type { BuiltinSkillCatalog } from "./builtin-skills/catalog.js";
import { type AgentCapability, createAgentAuthority } from "./capabilities.js";
import type { AgentExecutionContext } from "./execution-context.js";
import { LOOMIC_SYSTEM_PROMPT } from "./prompts/loomic-main.js";
import { createVideoSubAgent } from "./sub-agents.js";
import type {
  PersistImageFn,
  SubmitImageJobFn,
} from "./tools/image-generate.js";
import { createMainAgentTools } from "./tools/index.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";

export type LoomicAgent = Pick<ExactAgent, "stream" | "streamEvents">;

export type LoomicAgentFactory = (options: {
  applyCanvasOperations?: ApplyCanvasOperations;
  brandKitId?: string | null;
  canvasId?: string;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => any;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  persistImage?: PersistImageFn;
  providerRegistry: ProviderCatalog;

  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  store?: BaseStore;
  resolveWorkspaceId?: (context: {
    accessToken: string;
    userId: string;
    canvasId: string;
  }) => Promise<string>;
  executionContext?: AgentExecutionContext;
  builtinSkillCatalog?: BuiltinSkillCatalog;
  agentExecutionRepository?: AgentExecutionRepository;
  fencingToken?: number;
}) => LoomicAgent;

export function createLoomicAgent(options: {
  applyCanvasOperations?: ApplyCanvasOperations;
  brandKitId?: string | null;
  canvasId?: string;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => any;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  persistImage?: PersistImageFn;
  providerRegistry: ProviderCatalog;

  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  store?: BaseStore;
  resolveWorkspaceId?: (context: {
    accessToken: string;
    userId: string;
    canvasId: string;
  }) => Promise<string>;
  executionContext?: AgentExecutionContext;
  builtinSkillCatalog?: BuiltinSkillCatalog;
  agentExecutionRepository?: AgentExecutionRepository;
  fencingToken?: number;
}): LoomicAgent {
  applyOpenAICompatEnv(options.env);

  const modelSpec = options.model ?? createDefaultModelSpecifier(options.env);
  const resolvedModel =
    typeof modelSpec === "string"
      ? createStreamingChatModel(modelSpec)
      : modelSpec;

  const createUserClient =
    options.createUserClient ??
    ((_accessToken: string): never => {
      throw new Error(
        "inspect_canvas is unavailable: no createUserClient was provided to createLoomicAgent.",
      );
    });

  const systemPrompt = options.brandKitId
    ? LOOMIC_SYSTEM_PROMPT +
      "\n\n当前项目已绑定品牌套件。在进行设计相关工作时，请先使用 get_brand_kit 工具查询品牌信息，确保设计符合品牌规范。"
    : LOOMIC_SYSTEM_PROMPT;

  const tools = createMainAgentTools({
    ...(options.applyCanvasOperations && options.resolveWorkspaceId
      ? {
          applyCanvasOperations: options.applyCanvasOperations,
          resolveWorkspaceId: options.resolveWorkspaceId,
        }
      : {}),
    createUserClient,
    providerRegistry: options.providerRegistry,
    ...(options.brandKitId != null ? { brandKitId: options.brandKitId } : {}),
    ...(options.connectionManager
      ? { connectionManager: options.connectionManager }
      : {}),
    ...(options.persistImage ? { persistImage: options.persistImage } : {}),
    ...(options.submitImageJob
      ? { submitImageJob: options.submitImageJob }
      : {}),
    ...(options.submitVideoJob
      ? { submitVideoJob: options.submitVideoJob }
      : {}),
    ...(options.executionContext
      ? { executionContext: options.executionContext }
      : {}),
    ...(options.builtinSkillCatalog
      ? { builtinSkillCatalog: options.builtinSkillCatalog }
      : {}),
    ...(options.agentExecutionRepository
      ? { agentExecutionRepository: options.agentExecutionRepository }
      : {}),
    ...(options.fencingToken !== undefined
      ? { fencingToken: options.fencingToken }
      : {}),
  });
  const toolNames = new Set(tools.map((registeredTool) => registeredTool.name));
  const capabilities: AgentCapability[] = [
    "image.generate",
    "video.generate",
    "agent.delegate",
  ];
  if (toolNames.has("inspect_canvas")) capabilities.push("canvas.read");
  if (toolNames.has("manipulate_canvas")) capabilities.push("canvas.mutate");
  if (toolNames.has("get_brand_kit")) capabilities.push("brand_kit.read");
  if (toolNames.has("project_search")) capabilities.push("project.search");
  if (toolNames.has("read_builtin_skill")) capabilities.push("skill.read");

  return createExactLoomicAgent({
    authority: createAgentAuthority(capabilities),
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
    model: resolvedModel,
    ...(options.store ? { store: options.store } : {}),
    subagents: [createVideoSubAgent(options.providerRegistry)],
    systemPrompt,
    tools,
  });
}

/**
 * Create a streaming chat model from a `<provider>:<model-id>` specifier.
 *
 * Supported providers:
 * - `openai` (default) — uses ChatOpenAI with `streamUsage: false` to work
 *   around the one-api proxy stripping `delta.role` from chunks.
 * - `google` — uses ChatGoogleGenerativeAI (Google AI Studio, API Key) or
 *   ChatVertexAI (Vertex AI, service account) depending on available config.
 */
function createStreamingChatModel(specifier: string): BaseLanguageModel {
  const colonIdx = specifier.indexOf(":");
  let provider = colonIdx > 0 ? specifier.slice(0, colonIdx) : "openai";
  let modelName = colonIdx > 0 ? specifier.slice(colonIdx + 1) : specifier;

  const hasGoogleApiKey = !!process.env.GOOGLE_API_KEY;
  const hasVertexAI = !!(
    process.env.GOOGLE_VERTEX_PROJECT && process.env.GOOGLE_VERTEX_LOCATION
  );
  const hasGoogle = hasGoogleApiKey || hasVertexAI;

  // Provider availability fallback
  if (provider === "google" && !hasGoogle) {
    console.warn(
      `[model] Google unavailable (no GOOGLE_API_KEY or Vertex AI config), falling back to OpenAI for: ${specifier}`,
    );
    provider = "openai";
    modelName = DEFAULT_AGENT_MODEL;
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY && hasGoogle) {
    console.warn(
      `[model] OpenAI unavailable (no OPENAI_API_KEY), falling back to Google for: ${specifier}`,
    );
    provider = "google";
    modelName = DEFAULT_GOOGLE_AGENT_MODEL;
  }

  switch (provider) {
    case "google":
      // Prefer Vertex AI (service account) when configured; fall back to Developer API key
      if (hasVertexAI) {
        const vertexProject = process.env.GOOGLE_VERTEX_PROJECT!;
        const vertexLocation = process.env.GOOGLE_VERTEX_LOCATION!;
        console.log(
          `[model] Using Vertex AI for: ${modelName} (project=${vertexProject}, location=${vertexLocation})`,
        );
        return new ChatVertexAI({
          model: modelName,
          location: vertexLocation,
          authOptions: { projectId: vertexProject },
          streaming: true,
        });
      }
      return new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey: process.env.GOOGLE_API_KEY!,
        streaming: true,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1, // dynamic — let the model decide
        },
      });
    case "openai":
    default:
      return new ChatOpenAI({
        model: modelName,
        streaming: true,
        streamUsage: false,
      });
  }
}

/** Known model-name prefixes that map to Google Gemini. */
const GOOGLE_MODEL_PREFIXES = ["gemini-"];

export function createDefaultModelSpecifier(
  env: Pick<ServerEnv, "agentModel">,
) {
  const model = env.agentModel;
  // Already has an explicit provider prefix — pass through as-is.
  if (model.includes(":")) return model;
  // Auto-detect Google models by name prefix.
  if (GOOGLE_MODEL_PREFIXES.some((p) => model.startsWith(p)))
    return `google:${model}`;
  return `openai:${model}`;
}

export function applyOpenAICompatEnv(
  env: Pick<ServerEnv, "openAIApiBase" | "openAIApiKey">,
  target: NodeJS.ProcessEnv = process.env,
) {
  if (env.openAIApiKey) {
    target.OPENAI_API_KEY = env.openAIApiKey;
  }

  if (env.openAIApiBase) {
    target.OPENAI_BASE_URL = env.openAIApiBase;
  }
}
