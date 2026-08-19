import type { CanvasContent } from "@loomic/shared";
import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

const commitResultSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  replayed: z.boolean(),
  effectResult: z.unknown().optional(),
});

type RpcError = { details?: string; hint?: string };

export type CanvasRepository = ReturnType<typeof createCanvasRepository>;

export function createCanvasRepository(options: {
  createUserClient(accessToken: string): UserSupabaseClient;
  getAdminClient(): AdminSupabaseClient;
}) {
  return {
    async read(user: AuthenticatedUser, canvasId: string) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("canvases")
        .select("id, name, project_id, content, revision")
        .eq("id", canvasId)
        .single();
      if (error || !data) throw canvasNotFound();
      return {
        id: data.id,
        name: data.name,
        projectId: data.project_id,
        revision: Number(data.revision),
        content: (data.content as CanvasContent) ?? {
          elements: [],
          appState: {},
        },
      };
    },

    async commit(
      user: AuthenticatedUser,
      command: {
        canvasId: string;
        expectedRevision: number;
        content: CanvasContent;
        jobId?: string;
        effectKind?: string;
        agentEffect?: {
          runId: string;
          attemptId: string;
          fencingToken: number;
          logicalToolCallId: string;
          inputDigest: string;
          result: unknown;
        };
      },
    ) {
      const trustedCommit =
        command.jobId !== undefined || command.agentEffect !== undefined;
      const client = trustedCommit
        ? options.getAdminClient()
        : options.createUserClient(user.accessToken);
      const { data, error } = command.agentEffect
        ? await callRpc(client, "commit_agent_canvas_revision", {
            p_canvas_id: command.canvasId,
            p_actor_user_id: user.id,
            p_expected_revision: command.expectedRevision,
            p_content: command.content,
            p_run_id: command.agentEffect.runId,
            p_attempt_id: command.agentEffect.attemptId,
            p_fencing_token: command.agentEffect.fencingToken,
            p_logical_tool_call_id: command.agentEffect.logicalToolCallId,
            p_input_digest: command.agentEffect.inputDigest,
            p_result: command.agentEffect.result,
            p_job_id: command.jobId ?? null,
            p_effect_kind: command.effectKind ?? null,
          })
        : command.jobId !== undefined
          ? await callRpc(client, "commit_canvas_revision", {
              p_canvas_id: command.canvasId,
              p_actor_user_id: user.id,
              p_expected_revision: command.expectedRevision,
              p_content: command.content,
              p_job_id: command.jobId,
              p_effect_kind: command.effectKind ?? null,
            })
          : await callRpc(client, "save_canvas_revision", {
              p_canvas_id: command.canvasId,
              p_expected_revision: command.expectedRevision,
              p_content: command.content,
            });
      if (error) throw mapCommitError(error, command.expectedRevision);
      const parsed = commitResultSchema.safeParse(data);
      if (!parsed.success) {
        throw new AppError({
          code: "application_error",
          statusCode: 500,
          message: "Database returned an invalid Canvas commit result.",
        });
      }
      return parsed.data;
    },
  };
}

async function callRpc(
  client: UserSupabaseClient | AdminSupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: RpcError | null }> {
  return (
    client as unknown as {
      rpc(
        name: string,
        args: Record<string, unknown>,
      ): Promise<{ data: unknown; error: RpcError | null }>;
    }
  ).rpc(name, args);
}

function mapCommitError(error: RpcError, expectedRevision: number): AppError {
  if (error.details === "canvas_revision_conflict") {
    const hint = parseHint(error.hint);
    return new AppError({
      code: "canvas_revision_conflict",
      statusCode: 409,
      message: "The Canvas changed since it was loaded.",
      expose: true,
      details: {
        expectedRevision,
        ...(hint?.currentRevision !== undefined
          ? { currentRevision: hint.currentRevision }
          : {}),
      },
      cause: error,
    });
  }
  if (error.details === "canvas_not_found") throw canvasNotFound(error);
  return new AppError({
    code: "application_error",
    statusCode: 500,
    message: "Unable to commit Canvas changes.",
    cause: error,
  });
}

function parseHint(
  value: string | undefined,
): { currentRevision?: number } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { currentRevision?: unknown };
    return Number.isSafeInteger(parsed.currentRevision) &&
      Number(parsed.currentRevision) >= 0
      ? { currentRevision: Number(parsed.currentRevision) }
      : undefined;
  } catch {
    return undefined;
  }
}

function canvasNotFound(cause?: unknown): AppError {
  return new AppError({
    code: "canvas_not_found",
    statusCode: 404,
    message: "Canvas not found.",
    expose: true,
    cause,
  });
}
