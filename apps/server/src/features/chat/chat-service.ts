import { isDeepStrictEqual } from "node:util";

import type {
  ChatMessage,
  ChatMessageCreateRequest,
  ChatSessionSummary,
  ContentBlock,
  CursorPage,
  Json,
  PaginationQuery,
} from "@loomic/shared";

import type {
  CursorCodec,
  CursorScope,
} from "../../pagination/cursor-codec.js";
import { buildKeysetPredicate } from "../../pagination/keyset.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type { ThreadService } from "./thread-service.js";

export class ChatServiceError extends Error {
  readonly statusCode: number;
  readonly code: "chat_error" | "idempotency_conflict" | "session_not_found";

  constructor(
    code: "chat_error" | "idempotency_conflict" | "session_not_found",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type ChatService = {
  listSessions(
    user: AuthenticatedUser,
    canvasId: string,
  ): Promise<ChatSessionSummary[]>;
  listSessionsPage(
    user: AuthenticatedUser,
    canvasId: string,
    query: PaginationQuery,
  ): Promise<CursorPage<ChatSessionSummary>>;
  createSession(
    user: AuthenticatedUser,
    canvasId: string,
    title?: string,
  ): Promise<ChatSessionSummary>;
  updateSessionTitle(
    user: AuthenticatedUser,
    sessionId: string,
    title: string,
  ): Promise<void>;
  deleteSession(user: AuthenticatedUser, sessionId: string): Promise<void>;
  listMessages(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<ChatMessage[]>;
  listMessagesPage(
    user: AuthenticatedUser,
    sessionId: string,
    query: PaginationQuery,
  ): Promise<CursorPage<ChatMessage>>;
  createMessage(
    user: AuthenticatedUser,
    sessionId: string,
    input: ChatMessageCreateRequest & { id?: string | undefined },
  ): Promise<ChatMessage>;
};

/**
 * Synthesize content blocks from legacy `content` + `tool_activities` columns.
 * Produces the same ordering the old client saw: text first, then tool blocks.
 */
function synthesizeLegacyBlocks(
  content: string | null,
  toolActivities: unknown[] | null,
): ContentBlock[] | null {
  const blocks: ContentBlock[] = [];
  if (content) {
    blocks.push({ type: "text", text: content });
  }
  if (toolActivities && Array.isArray(toolActivities)) {
    for (const t of toolActivities) {
      blocks.push({
        type: "tool",
        ...(t as Omit<ContentBlock & { type: "tool" }, "type">),
      });
    }
  }
  return blocks.length > 0 ? blocks : null;
}

export function deduplicateAdjacentMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  const deduplicated: ChatMessage[] = [];
  for (const message of messages) {
    const previous = deduplicated.at(-1);
    if (
      !previous ||
      message.role !== "assistant" ||
      previous.role !== message.role ||
      previous.content !== message.content
    ) {
      deduplicated.push(message);
      continue;
    }
    if (compareLifecycleRichness(message, previous) > 0) {
      deduplicated[deduplicated.length - 1] = message;
    }
  }
  return deduplicated;
}

function compareLifecycleRichness(
  candidate: ChatMessage,
  existing: ChatMessage,
): number {
  const candidateBlocks = candidate.contentBlocks ?? [];
  const existingBlocks = existing.contentBlocks ?? [];
  const scores = [
    countTerminalToolBlocks(candidateBlocks) -
      countTerminalToolBlocks(existingBlocks),
    countArtifacts(candidateBlocks) - countArtifacts(existingBlocks),
    candidateBlocks.length - existingBlocks.length,
  ];
  return scores.find((score) => score !== 0) ?? 0;
}

function countTerminalToolBlocks(blocks: ContentBlock[]): number {
  return blocks.filter(
    (block) =>
      block.type === "tool" &&
      (block.status === "completed" || block.status === "failed"),
  ).length;
}

function countArtifacts(blocks: ContentBlock[]): number {
  return blocks.reduce(
    (count, block) =>
      count + (block.type === "tool" ? (block.artifacts?.length ?? 0) : 0),
    0,
  );
}

export function createChatService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  threadService: Pick<ThreadService, "createThreadId">;
  cursorCodec?: CursorCodec;
  logger?: { error(event: string, context: Record<string, unknown>): void };
}): ChatService {
  return {
    async listSessions(user, canvasId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("chat_sessions")
        .select("id, title, updated_at")
        .eq("canvas_id", canvasId)
        .order("updated_at", { ascending: false });

      if (error) {
        throw new ChatServiceError(
          "chat_error",
          "Failed to list sessions.",
          500,
        );
      }

      return (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
      }));
    },

    async listSessionsPage(user, canvasId, query) {
      const cursorCodec = requireChatCursorCodec(options.cursorCodec);
      const client = options.createUserClient(user.accessToken);
      const workspaceId = await resolveCanvasWorkspace(client, canvasId);
      const scope: CursorScope = {
        userId: user.id,
        workspaceId,
        owner: "chat_sessions",
        filterHash: canvasId,
        direction: "desc",
      };
      const boundary = query.cursor
        ? cursorCodec.decode(query.cursor, scope)
        : undefined;
      let collectionQuery = client
        .from("chat_sessions")
        .select("id, title, updated_at")
        .eq("canvas_id", canvasId)
        .eq("created_by", user.id)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(query.limit + 1);
      if (boundary) {
        collectionQuery = collectionQuery.or(
          serializeKeyset("updated_at", boundary),
        );
      }
      const { data, error } = await collectionQuery;
      if (error) {
        logChatPagingFailure(
          options.logger,
          "chat_sessions",
          user.id,
          workspaceId,
        );
        throw new ChatServiceError(
          "chat_error",
          "Failed to list sessions.",
          500,
        );
      }
      const pageRows = (data ?? []).slice(0, query.limit);
      const tail = pageRows.at(-1);
      return {
        items: pageRows.map((row) => ({
          id: row.id,
          title: row.title,
          updatedAt: row.updated_at,
        })),
        nextCursor:
          data && data.length > query.limit && tail
            ? cursorCodec.encode(scope, {
                timestamp: tail.updated_at,
                id: tail.id,
              })
            : null,
      };
    },

    async createSession(user, canvasId, title) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("chat_sessions")
        .insert({
          canvas_id: canvasId,
          created_by: user.id,
          thread_id: options.threadService.createThreadId(),
          ...(title ? { title } : {}),
        })
        .select("id, title, updated_at")
        .single();

      if (error || !data) {
        throw new ChatServiceError(
          "chat_error",
          "Failed to create session.",
          500,
        );
      }

      return {
        id: data.id,
        title: data.title,
        updatedAt: data.updated_at,
      };
    },

    async updateSessionTitle(user, sessionId, title) {
      const client = options.createUserClient(user.accessToken);
      const { error } = await client
        .from("chat_sessions")
        .update({ title })
        .eq("id", sessionId);

      if (error) {
        throw new ChatServiceError(
          "chat_error",
          "Failed to update session title.",
          500,
        );
      }
    },

    async deleteSession(user, sessionId) {
      const client = options.createUserClient(user.accessToken);
      const { error } = await client
        .from("chat_sessions")
        .delete()
        .eq("id", sessionId);

      if (error) {
        throw new ChatServiceError(
          "session_not_found",
          "Session not found.",
          404,
        );
      }
    },

    async listMessages(user, sessionId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("chat_messages")
        .select(
          "id, role, content, tool_activities, content_blocks, created_at",
        )
        .eq("session_id", sessionId)
        .is("superseded_by", null)
        .order("created_at", { ascending: true });

      if (error) {
        throw new ChatServiceError(
          "chat_error",
          "Failed to list messages.",
          500,
        );
      }

      const rows = (data ?? []).map((row) => {
        const contentBlocks =
          Array.isArray(row.content_blocks) && row.content_blocks.length > 0
            ? (row.content_blocks as ContentBlock[])
            : synthesizeLegacyBlocks(
                row.content,
                row.tool_activities as unknown[] | null,
              );

        return {
          id: row.id,
          role: row.role as "user" | "assistant",
          content: row.content,
          toolActivities: row.tool_activities as ChatMessage["toolActivities"],
          contentBlocks,
          createdAt: row.created_at,
        };
      });

      // During the static-client transition, retain the richer server record.
      return deduplicateAdjacentMessages(rows);
    },

    async listMessagesPage(user, sessionId, query) {
      const cursorCodec = requireChatCursorCodec(options.cursorCodec);
      const client = options.createUserClient(user.accessToken);
      const sessionScope = await resolveSessionScope(
        client,
        user.id,
        sessionId,
      );
      const scope: CursorScope = {
        userId: user.id,
        workspaceId: sessionScope.workspaceId,
        owner: "chat_messages",
        filterHash: sessionId,
        direction: "desc",
      };
      const boundary = query.cursor
        ? cursorCodec.decode(query.cursor, scope)
        : undefined;
      let collectionQuery = client
        .from("chat_messages")
        .select(
          "id, role, content, tool_activities, content_blocks, created_at",
        )
        .eq("session_id", sessionId)
        .is("superseded_by", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(query.limit + 1);
      if (boundary) {
        collectionQuery = collectionQuery.or(
          serializeKeyset("created_at", boundary),
        );
      }
      const { data, error } = await collectionQuery;
      if (error) {
        logChatPagingFailure(
          options.logger,
          "chat_messages",
          user.id,
          sessionScope.workspaceId,
        );
        throw new ChatServiceError(
          "chat_error",
          "Failed to list messages.",
          500,
        );
      }
      const pageRows = (data ?? []).slice(0, query.limit);
      const tail = pageRows.at(-1);
      return {
        items: pageRows.map(mapMessageRow).reverse(),
        nextCursor:
          data && data.length > query.limit && tail
            ? cursorCodec.encode(scope, {
                timestamp: tail.created_at,
                id: tail.id,
              })
            : null,
      };
    },

    async createMessage(user, sessionId, input) {
      const client = options.createUserClient(user.accessToken);
      const messageInsert = {
        ...(input.id ? { id: input.id } : {}),
        session_id: sessionId,
        role: input.role,
        content: input.content,
        ...(input.toolActivities
          ? { tool_activities: input.toolActivities as unknown as Json }
          : {}),
        ...(input.contentBlocks
          ? { content_blocks: input.contentBlocks as unknown as Json }
          : {}),
      };
      const { data: inserted, error } = await client
        .from("chat_messages")
        .insert(messageInsert)
        .select(
          "id, role, content, tool_activities, content_blocks, created_at",
        )
        .single();

      let data = inserted;
      if (error?.code === "23505" && input.id) {
        const { data: existing, error: existingError } = await client
          .from("chat_messages")
          .select(
            "id, session_id, role, content, tool_activities, content_blocks, created_at",
          )
          .eq("id", input.id)
          .maybeSingle();
        if (existingError || !existing) {
          options.logger?.error(
            "chat.message_idempotency_verification_failed",
            {
              code: "stable_message_verification_unavailable",
              stage: "idempotency_verification",
            },
          );
          throw new ChatServiceError(
            "chat_error",
            "Failed to verify the existing message.",
            500,
          );
        }
        if (!isIdempotentMessage(existing, sessionId, input)) {
          options.logger?.error("chat.message_conflict", {
            code: "stable_message_id_conflict",
            stage: "idempotency_verification",
          });
          throw new ChatServiceError(
            "idempotency_conflict",
            "Message identity conflicts with an existing message.",
            409,
          );
        }
        data = existing;
      } else if (error || !data) {
        throw new ChatServiceError(
          "chat_error",
          "Failed to save message.",
          500,
        );
      }

      // Touch session updated_at
      await client
        .from("chat_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", sessionId);

      const contentBlocks =
        Array.isArray(data.content_blocks) && data.content_blocks.length > 0
          ? (data.content_blocks as ContentBlock[])
          : synthesizeLegacyBlocks(
              data.content,
              data.tool_activities as unknown[] | null,
            );

      return {
        id: data.id,
        role: data.role as "user" | "assistant",
        content: data.content,
        toolActivities: data.tool_activities as ChatMessage["toolActivities"],
        contentBlocks,
        createdAt: data.created_at,
      };
    },
  };
}

function isIdempotentMessage(
  existing: {
    id: string;
    session_id: string;
    role: string;
    content: string;
    tool_activities: Json;
    content_blocks: Json;
  },
  sessionId: string,
  input: ChatMessageCreateRequest & { id?: string | undefined },
): boolean {
  return (
    existing.id === input.id &&
    existing.session_id === sessionId &&
    existing.role === input.role &&
    existing.content === input.content &&
    isDeepStrictEqual(existing.tool_activities, input.toolActivities ?? null) &&
    isDeepStrictEqual(existing.content_blocks, input.contentBlocks ?? null)
  );
}

type MessageRow = {
  id: string;
  role: string;
  content: string;
  tool_activities: Json;
  content_blocks: Json;
  created_at: string;
};

function mapMessageRow(row: MessageRow): ChatMessage {
  const contentBlocks =
    Array.isArray(row.content_blocks) && row.content_blocks.length > 0
      ? (row.content_blocks as ContentBlock[])
      : synthesizeLegacyBlocks(
          row.content,
          row.tool_activities as unknown[] | null,
        );
  return {
    id: row.id,
    role: row.role as "user" | "assistant",
    content: row.content,
    toolActivities: row.tool_activities as ChatMessage["toolActivities"],
    contentBlocks,
    createdAt: row.created_at,
  };
}

function requireChatCursorCodec(codec: CursorCodec | undefined): CursorCodec {
  if (!codec) {
    throw new Error("CursorCodec is required for paged chat queries.");
  }
  return codec;
}

async function resolveCanvasWorkspace(
  client: UserSupabaseClient,
  canvasId: string,
): Promise<string> {
  const { data, error } = await client
    .from("canvases")
    .select("id, projects!inner(workspace_id)")
    .eq("id", canvasId)
    .maybeSingle();
  const project = data?.projects as unknown as { workspace_id?: string } | null;
  if (error || !project?.workspace_id) {
    throw new ChatServiceError("chat_error", "Failed to list sessions.", 500);
  }
  return project.workspace_id;
}

async function resolveSessionScope(
  client: UserSupabaseClient,
  userId: string,
  sessionId: string,
): Promise<{ workspaceId: string }> {
  const { data, error } = await client
    .from("chat_sessions")
    .select(
      "id, canvas_id, created_by, canvases!inner(projects!inner(workspace_id))",
    )
    .eq("id", sessionId)
    .eq("created_by", userId)
    .maybeSingle();
  const canvas = data?.canvases as unknown as {
    projects?: { workspace_id?: string };
  } | null;
  if (error || !canvas?.projects?.workspace_id) {
    throw new ChatServiceError("session_not_found", "Session not found.", 404);
  }
  return { workspaceId: canvas.projects.workspace_id };
}

function serializeKeyset(
  timestampColumn: string,
  boundary: { timestamp: string; id: string },
): string {
  const predicate = buildKeysetPredicate("desc", boundary);
  const range = predicate.branches[0][0];
  return `${timestampColumn}.${range.operator}.${range.value},and(${timestampColumn}.eq.${boundary.timestamp},id.${range.operator}.${boundary.id})`;
}

function logChatPagingFailure(
  logger:
    | { error(event: string, context: Record<string, unknown>): void }
    | undefined,
  collection: string,
  userId: string,
  workspaceId: string,
): void {
  logger?.error("pagination.query_failed", {
    collection,
    stage: "collection_query",
    userId,
    workspaceId,
  });
}
