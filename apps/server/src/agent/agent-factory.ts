import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { StructuredTool } from "@langchain/core/tools";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import type { AgentMiddleware } from "langchain";
import { createAgent as createLangChainAgent, tool } from "langchain";
import { z } from "zod";

import {
  type AgentAuthority,
  CLASSIFIED_AGENT_TOOL_NAMES,
} from "./capabilities.js";

export interface ExactAgent {
  invoke?: (input: unknown) => Promise<unknown>;
  stream: (...args: any[]) => any;
  streamEvents: (...args: any[]) => any;
}

export interface SubagentDefinition {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly tools: readonly StructuredTool[];
}

export interface ExactAgentOptions {
  model: BaseLanguageModel | string;
  systemPrompt: string;
  tools: StructuredTool[];
  middleware: AgentMiddleware[];
  checkpointer?: BaseCheckpointSaver;
  store?: BaseStore;
}

export type CreateAgentFn = (options: ExactAgentOptions) => ExactAgent;

export function createExactLoomicAgent(options: {
  authority: AgentAuthority;
  model: BaseLanguageModel | string;
  systemPrompt: string;
  tools: readonly StructuredTool[];
  middleware: readonly AgentMiddleware[];
  subagents?: readonly SubagentDefinition[];
  checkpointer?: BaseCheckpointSaver;
  store?: BaseStore;
  createAgent?: CreateAgentFn;
}): ExactAgent {
  const suppliedTools = indexClassifiedTools(options.tools);
  const createAgent =
    options.createAgent ?? (createLangChainAgent as unknown as CreateAgentFn);
  const registeredSubagents = new Map<string, ExactAgent>();
  const toolMiddleware = (options.middleware ?? []).filter(
    (middleware) => middleware.wrapToolCall !== undefined,
  );
  if (toolMiddleware.length !== 1) {
    throw new Error("single_tool_governance_middleware_required");
  }

  for (const authority of options.authority.subagents) {
    const definition = options.subagents?.find(
      (candidate) => candidate.name === authority.name,
    );
    if (!definition)
      throw new Error(`missing_agent_subagent:${authority.name}`);
    const subagentTools = selectAuthorizedTools(
      indexClassifiedTools(definition.tools),
      authority.toolNames,
    );
    registeredSubagents.set(
      authority.name,
      createAgent({
        model: options.model,
        systemPrompt: definition.systemPrompt,
        tools: subagentTools,
        middleware: [...options.middleware],
        ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
        ...(options.store ? { store: options.store } : {}),
      }),
    );
  }

  const mainTools = selectAuthorizedTools(
    suppliedTools,
    options.authority.mainToolNames,
  );
  if (registeredSubagents.size > 0) {
    const names = [...registeredSubagents.keys()] as [string, ...string[]];
    mainTools.push(
      tool(
        async ({ subagentType, task: delegatedTask }) => {
          const subagent = registeredSubagents.get(subagentType);
          if (!subagent?.invoke) throw new Error("agent_subagent_unavailable");
          return JSON.stringify(
            await subagent.invoke({
              messages: [{ role: "user", content: delegatedTask }],
            }),
          );
        },
        {
          name: "task",
          description: "Delegate a bounded task to an authorized specialist.",
          schema: z.object({
            subagentType: z.enum(names),
            task: z.string().min(1).max(16_384),
          }),
        },
      ),
    );
  }

  return createAgent({
    model: options.model,
    systemPrompt: options.systemPrompt,
    tools: mainTools,
    middleware: [...options.middleware],
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
    ...(options.store ? { store: options.store } : {}),
  });
}

function indexClassifiedTools(
  tools: readonly StructuredTool[],
): ReadonlyMap<string, StructuredTool> {
  const result = new Map<string, StructuredTool>();
  for (const registeredTool of tools) {
    if (result.has(registeredTool.name))
      throw new Error("duplicate_agent_tool");
    if (!CLASSIFIED_AGENT_TOOL_NAMES.includes(registeredTool.name)) {
      throw new Error("unclassified_agent_tool");
    }
    result.set(registeredTool.name, registeredTool);
  }
  return result;
}

function selectAuthorizedTools(
  supplied: ReadonlyMap<string, StructuredTool>,
  authorizedNames: readonly string[],
): StructuredTool[] {
  return authorizedNames.map((name) => {
    const registeredTool = supplied.get(name);
    if (!registeredTool) throw new Error(`missing_authorized_tool:${name}`);
    return registeredTool;
  });
}
