import {
  DynamicStructuredTool,
  type StructuredTool,
} from "@langchain/core/tools";
import type { AgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";
import type { AgentCapability } from "../capabilities.js";
import type { AgentExecutionContext } from "../execution-context.js";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OPERATIONS = 100;
const MAX_RECORDS = 100;
const FORBIDDEN_KEYS = new Set([
  "canvasid",
  "projectid",
  "workspaceid",
  "userid",
  "accesstoken",
  "storagepath",
  "objectkey",
  "bucket",
  "url",
]);

export async function guardToolCall<T>(options: {
  capability: AgentCapability;
  context: AgentExecutionContext;
  repository: AgentExecutionRepository;
  input: unknown;
  invoke: () => Promise<T>;
}): Promise<T> {
  assertBoundedInput(options.input);
  const active = await options.repository.getExecutionContext(
    options.context.runId,
  );
  if (!active || active.attemptId !== options.context.attemptId) {
    throw new Error("run_not_active");
  }
  if (
    !options.context.capabilities.includes(options.capability) ||
    !active.capabilities.includes(options.capability)
  ) {
    throw new Error("capability_denied");
  }
  if (
    active.canvasId !== options.context.canvasId ||
    active.projectId !== options.context.projectId ||
    active.workspaceId !== options.context.workspaceId ||
    active.userId !== options.context.userId
  ) {
    throw new Error("tool_not_authorized");
  }

  const result = await options.invoke();
  assertBoundedResult(result);
  return result;
}

export function guardStructuredTool(options: {
  capability: AgentCapability;
  context: AgentExecutionContext;
  repository: AgentExecutionRepository;
  registeredTool: StructuredTool;
}): StructuredTool {
  return new DynamicStructuredTool({
    name: options.registeredTool.name,
    description: options.registeredTool.description,
    schema: options.registeredTool.schema,
    func: async (input, _runManager, config) =>
      guardToolCall({
        capability: options.capability,
        context: options.context,
        repository: options.repository,
        input,
        invoke: async () => options.registeredTool.invoke(input, config),
      }),
  }) as StructuredTool;
}

function assertBoundedInput(input: unknown): void {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES) {
    throw new Error("tool_input_too_large");
  }
  if (
    isRecord(input) &&
    Array.isArray(input.operations) &&
    input.operations.length > MAX_OPERATIONS
  ) {
    throw new Error("tool_input_too_large");
  }
  visitInput(input);
}

function visitInput(value: unknown): void {
  if (typeof value === "string" && /^(?:https?:|data:|file:)/i.test(value)) {
    throw new Error("tool_not_authorized");
  }
  if (Array.isArray(value)) {
    for (const item of value) visitInput(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.replaceAll("_", "").toLowerCase();
    if (FORBIDDEN_KEYS.has(normalizedKey)) {
      throw new Error("tool_not_authorized");
    }
    visitInput(nested);
  }
}

function assertBoundedResult(result: unknown): void {
  const serialized =
    typeof result === "string" ? result : JSON.stringify(result);
  if (Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES) {
    throw new Error("tool_result_too_large");
  }
  let recordSource = result;
  if (typeof result === "string") {
    try {
      recordSource = JSON.parse(result);
    } catch {
      recordSource = result;
    }
  }
  if (countRecords(recordSource) > MAX_RECORDS) {
    throw new Error("tool_result_too_large");
  }
}

function countRecords(value: unknown): number {
  if (Array.isArray(value)) {
    return (
      value.length +
      value.reduce((total, item) => total + countRecords(item), 0)
    );
  }
  if (!isRecord(value)) return 0;
  return Object.values(value).reduce<number>(
    (total, nested) => total + countRecords(nested),
    0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
