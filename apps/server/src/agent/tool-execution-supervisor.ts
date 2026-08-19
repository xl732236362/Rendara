import {
  type CanonicalToolCompleted,
  type CanonicalToolFailed,
  type CanonicalToolRecord,
  type CanonicalToolStarted,
  canonicalRecordsEqual,
  canonicalToolRecordSchema,
} from "./tool-lifecycle.js";

export type ToolCallState = "starting" | "open" | "finishing" | "terminal";

type SupervisorOptions = {
  readonly agentRunId: string;
  readonly attemptId: string;
  readonly maxBytes: number;
  readonly maxCalls: number;
  readonly now?: () => string;
};

type StartInput = {
  readonly logicalToolCallId: string;
  readonly toolName: string;
  readonly inputDigest: string;
  readonly input?: Readonly<Record<string, unknown>>;
};

type CompletedPayload = Pick<
  CanonicalToolCompleted,
  "artifacts" | "output" | "outputSummary"
>;

type FailedPayload = CanonicalToolFailed["error"];

type StoredRecord = {
  readonly record: CanonicalToolRecord;
  projected: boolean;
};

export interface ToolExecutionSupervisor {
  stageStart(input: StartInput): CanonicalToolStarted;
  stageCompleted(
    logicalToolCallId: string,
    payload: CompletedPayload,
  ): CanonicalToolCompleted;
  stageFailed(
    logicalToolCallId: string,
    error: FailedPayload,
  ): CanonicalToolFailed;
  acknowledge(record: CanonicalToolRecord): "projected" | "duplicate";
  closeOpenCalls(error: FailedPayload): readonly CanonicalToolFailed[];
  callState(logicalToolCallId: string): ToolCallState | undefined;
  records(): readonly CanonicalToolRecord[];
  unacknowledgedRecords(): readonly CanonicalToolRecord[];
  isClosing(): boolean;
}

export function createToolExecutionSupervisor(
  options: SupervisorOptions,
): ToolExecutionSupervisor {
  if (options.maxCalls < 1 || options.maxBytes < 1) {
    throw new Error("tool_supervisor_invalid_capacity");
  }

  const now = options.now ?? (() => new Date().toISOString());
  const calls = new Map<
    string,
    { state: ToolCallState; toolName: string; inputDigest: string }
  >();
  const staged: StoredRecord[] = [];
  let admission: "open" | "closing" = "open";
  let nextSequence = 1;
  let serializedBytes = 0;

  function parseAndReserve<T extends CanonicalToolRecord>(record: T): T {
    const parsed = canonicalToolRecordSchema.parse(record) as T;
    const bytes = Buffer.byteLength(JSON.stringify(parsed));
    if (serializedBytes + bytes > options.maxBytes) {
      throw new Error("tool_supervisor_capacity_exhausted");
    }
    serializedBytes += bytes;
    staged.push({ record: parsed, projected: false });
    nextSequence += 1;
    return parsed;
  }

  function common(call: {
    logicalToolCallId: string;
    toolName: string;
    inputDigest: string;
  }) {
    return {
      schemaVersion: 1 as const,
      sequence: nextSequence,
      agentRunId: options.agentRunId,
      attemptId: options.attemptId,
      logicalToolCallId: call.logicalToolCallId,
      toolName: call.toolName,
      inputDigest: call.inputDigest,
      timestamp: now(),
    };
  }

  function requireOpenCall(logicalToolCallId: string) {
    const call = calls.get(logicalToolCallId);
    if (!call) throw new Error("unknown_logical_tool_call_id");
    if (call.state !== "open") throw new Error("tool_call_not_open");
    return call;
  }

  function stageTerminal(
    logicalToolCallId: string,
    terminal:
      | { type: "loomic.tool.completed"; payload: CompletedPayload }
      | { type: "loomic.tool.failed"; payload: FailedPayload },
    privilegedClosing: boolean,
  ): CanonicalToolCompleted | CanonicalToolFailed {
    const call = calls.get(logicalToolCallId);
    if (!call) throw new Error("unknown_logical_tool_call_id");
    if (
      call.state !== "open" &&
      !(privilegedClosing && call.state === "starting")
    ) {
      throw new Error("tool_call_not_open");
    }

    const record =
      terminal.type === "loomic.tool.completed"
        ? parseAndReserve({
            ...common({ logicalToolCallId, ...call }),
            type: terminal.type,
            ...terminal.payload,
          })
        : parseAndReserve({
            ...common({ logicalToolCallId, ...call }),
            type: terminal.type,
            error: terminal.payload,
          });
    call.state = "finishing";
    return record;
  }

  return {
    stageStart(input) {
      if (admission !== "open") throw new Error("tool_supervisor_closing");
      if (calls.has(input.logicalToolCallId)) {
        throw new Error("duplicate_logical_tool_call_id");
      }
      if (calls.size >= options.maxCalls) {
        throw new Error("tool_supervisor_capacity_exhausted");
      }

      const record = parseAndReserve({
        ...common(input),
        type: "loomic.tool.started",
        ...(input.input ? { input: input.input } : {}),
      });
      calls.set(input.logicalToolCallId, {
        state: "starting",
        toolName: input.toolName,
        inputDigest: input.inputDigest,
      });
      return record;
    },

    stageCompleted(logicalToolCallId, payload) {
      if (admission !== "open") throw new Error("tool_supervisor_closing");
      requireOpenCall(logicalToolCallId);
      return stageTerminal(
        logicalToolCallId,
        { type: "loomic.tool.completed", payload },
        false,
      ) as CanonicalToolCompleted;
    },

    stageFailed(logicalToolCallId, error) {
      if (admission !== "open") throw new Error("tool_supervisor_closing");
      requireOpenCall(logicalToolCallId);
      return stageTerminal(
        logicalToolCallId,
        { type: "loomic.tool.failed", payload: error },
        false,
      ) as CanonicalToolFailed;
    },

    acknowledge(candidate) {
      const stored = staged.find(
        ({ record }) => record.sequence === candidate.sequence,
      );
      if (!stored || !canonicalRecordsEqual(stored.record, candidate)) {
        throw new Error("tool_lifecycle_record_conflict");
      }
      if (stored.projected) return "duplicate";

      const next = staged.find(({ projected }) => !projected);
      if (next !== stored)
        throw new Error("tool_lifecycle_record_out_of_order");
      stored.projected = true;

      const call = calls.get(stored.record.logicalToolCallId);
      if (!call) throw new Error("unknown_logical_tool_call_id");
      if (stored.record.type === "loomic.tool.started") {
        if (call.state === "starting") call.state = "open";
      } else {
        if (call.state !== "finishing") {
          throw new Error("tool_lifecycle_state_conflict");
        }
        call.state = "terminal";
      }
      return "projected";
    },

    closeOpenCalls(error) {
      if (admission === "closing") return [];
      admission = "closing";
      const records: CanonicalToolFailed[] = [];
      for (const [logicalToolCallId, call] of calls) {
        if (call.state !== "starting" && call.state !== "open") continue;
        records.push(
          stageTerminal(
            logicalToolCallId,
            { type: "loomic.tool.failed", payload: error },
            true,
          ) as CanonicalToolFailed,
        );
      }
      return records;
    },

    callState(logicalToolCallId) {
      return calls.get(logicalToolCallId)?.state;
    },

    records() {
      return staged.map(({ record }) => record);
    },

    unacknowledgedRecords() {
      return staged
        .filter(({ projected }) => !projected)
        .map(({ record }) => record);
    },

    isClosing() {
      return admission === "closing";
    },
  };
}
