import { describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@loomic/shared";
import { deduplicateAdjacentMessages } from "./chat-service.js";
import { createChatService } from "./chat-service.js";

const timestamp = "2026-08-20T00:00:00.000Z";

describe("deduplicateAdjacentMessages", () => {
  it("keeps the adjacent duplicate with richer terminal lifecycle state", () => {
    const messages: ChatMessage[] = [
      {
        id: "legacy-assistant",
        role: "assistant",
        content: "Generated media.",
        createdAt: timestamp,
        contentBlocks: [
          { type: "text", text: "Generated media." },
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "running",
          },
        ],
      },
      {
        id: "server-assistant",
        role: "assistant",
        content: "Generated media.",
        createdAt: timestamp,
        contentBlocks: [
          { type: "text", text: "Generated media." },
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "completed",
            artifacts: [
              {
                type: "image",
                source: {
                  kind: "external",
                  url: "https://example.com/generated.png",
                },
                url: "https://example.com/generated.png",
                mimeType: "image/png",
                width: 512,
                height: 512,
              },
            ],
          },
        ],
      },
      {
        id: "user-message",
        role: "user",
        content: "Next request.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Next request." }],
      },
    ];

    expect(deduplicateAdjacentMessages(messages)).toEqual([
      messages[1],
      messages[2],
    ]);
  });

  it("keeps the earlier duplicate when lifecycle richness is identical", () => {
    const messages: ChatMessage[] = [
      {
        id: "earlier",
        role: "assistant",
        content: "Same content.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Same content." }],
      },
      {
        id: "later",
        role: "assistant",
        content: "Same content.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Same content." }],
      },
    ];

    expect(deduplicateAdjacentMessages(messages)).toEqual([messages[0]]);
  });

  it("does not deduplicate adjacent user messages with identical content", () => {
    const messages: ChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "Repeat request.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Repeat request." }],
      },
      {
        id: "user-2",
        role: "user",
        content: "Repeat request.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Repeat request." }],
      },
    ];

    expect(deduplicateAdjacentMessages(messages)).toEqual(messages);
  });

  it("uses artifacts and block count as lifecycle richness tiebreakers", () => {
    const messages: ChatMessage[] = [
      {
        id: "artifact-poor",
        role: "assistant",
        content: "With artifact.",
        createdAt: timestamp,
        contentBlocks: [
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "completed",
          },
        ],
      },
      {
        id: "artifact-rich",
        role: "assistant",
        content: "With artifact.",
        createdAt: timestamp,
        contentBlocks: [
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "completed",
            artifacts: [
              {
                type: "image",
                source: {
                  kind: "external",
                  url: "https://example.com/generated.png",
                },
                url: "https://example.com/generated.png",
                mimeType: "image/png",
                width: 512,
                height: 512,
              },
            ],
          },
        ],
      },
      {
        id: "separator",
        role: "user",
        content: "Next request.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Next request." }],
      },
      {
        id: "block-poor",
        role: "assistant",
        content: "Detailed response.",
        createdAt: timestamp,
        contentBlocks: [{ type: "text", text: "Detailed response." }],
      },
      {
        id: "block-rich",
        role: "assistant",
        content: "Detailed response.",
        createdAt: timestamp,
        contentBlocks: [
          { type: "text", text: "Detailed response." },
          { type: "thinking", thinking: "Stored additional context." },
        ],
      },
    ];

    expect(deduplicateAdjacentMessages(messages)).toEqual([
      messages[1],
      messages[2],
      messages[4],
    ]);
  });
});

describe("chat canonical reads", () => {
  it("excludes superseded message rows from legacy reads", async () => {
    const calls: unknown[][] = [];
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "order"]) {
      query[method] = (...args: unknown[]) => {
        calls.push([method, ...args]);
        return query;
      };
    }
    query.then = (resolve: (value: unknown) => unknown) =>
      resolve({ data: [], error: null });
    const service = createChatService({
      createUserClient: () => ({ from: () => query }) as never,
      threadService: { createThreadId: () => "thread-1" },
    });

    await service.listMessages(
      {
        accessToken: "token",
        email: "user@example.com",
        id: "user-1",
        userMetadata: {},
      },
      "session-1",
    );

    expect(calls).toContainEqual(["is", "superseded_by", null]);
  });
});

describe("chat message append-only identity", () => {
  const authenticatedUser = {
    accessToken: "private-token",
    email: "user@example.com",
    id: "user-1",
    userMetadata: {},
  };
  const stableInput = {
    id: "11111111-1111-4111-8111-111111111111",
    role: "assistant" as const,
    content: "Stable response.",
    toolActivities: [
      {
        toolCallId: "tool-1",
        toolName: "inspect_canvas",
        status: "completed" as const,
      },
    ],
    contentBlocks: [{ type: "text" as const, text: "Stable response." }],
  };

  it("uses a plain insert for the first write with a stable id", async () => {
    const db = messageDatabase({
      insertData: persistedRow("session-1", stableInput),
    });

    await messageService(db).createMessage(
      authenticatedUser,
      "session-1",
      stableInput,
    );

    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: stableInput.id }),
    );
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.sessionUpdates).toHaveLength(1);
  });

  it("treats a duplicate insert as success only after reading an identical row", async () => {
    const existing = persistedRow("session-1", stableInput);
    const db = messageDatabase({
      insertError: { code: "23505", message: "duplicate key" },
      existing,
    });

    await expect(
      messageService(db).createMessage(
        authenticatedUser,
        "session-1",
        stableInput,
      ),
    ).resolves.toMatchObject({ id: stableInput.id });

    expect(db.existingSelect).toHaveBeenCalledWith(
      "id, session_id, role, content, tool_activities, content_blocks, created_at",
    );
    expect(db.existingId).toHaveBeenCalledWith("id", stableInput.id);
    expect(db.sessionUpdates).toHaveLength(1);
  });

  it.each([
    ["session", { session_id: "session-other" }],
    ["role", { role: "user" }],
    ["content", { content: "Different response." }],
    ["tool activities", { tool_activities: [] }],
    ["content blocks", { content_blocks: [] }],
  ] satisfies Array<[string, Partial<ReturnType<typeof persistedRow>>]>)(
    "rejects a duplicate id with different %s without touching the session",
    async (_label, difference) => {
      const logger = { error: vi.fn() };
      const db = messageDatabase({
        insertError: { code: "23505", message: "duplicate key" },
        existing: { ...persistedRow("session-1", stableInput), ...difference },
      });

      await expect(
        messageService(db, logger).createMessage(
          authenticatedUser,
          "session-1",
          stableInput,
        ),
      ).rejects.toMatchObject({ code: "message_conflict", statusCode: 409 });

      expect(db.sessionUpdates).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith("chat.message_conflict", {
        code: "stable_message_id_conflict",
        stage: "idempotency_verification",
      });
      const logged = JSON.stringify(logger.error.mock.calls);
      expect(logged).not.toContain(authenticatedUser.accessToken);
      expect(logged).not.toContain(stableInput.id);
      expect(logged).not.toContain(stableInput.content);
      expect(logged).not.toContain("tool-1");
    },
  );

  it.each([
    [
      "query error",
      { existingError: { code: "42501", message: "permission denied" } },
    ],
    ["row unavailable", {}],
  ])(
    "returns a safe server error when duplicate verification has a %s",
    async (_label, verification) => {
      const logger = { error: vi.fn() };
      const db = messageDatabase({
        insertError: { code: "23505", message: "duplicate key" },
        ...verification,
      });

      await expect(
        messageService(db, logger).createMessage(
          authenticatedUser,
          "session-1",
          stableInput,
        ),
      ).rejects.toMatchObject({ code: "chat_error", statusCode: 500 });

      expect(db.sessionUpdates).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        "chat.message_idempotency_verification_failed",
        {
          code: "stable_message_verification_unavailable",
          stage: "idempotency_verification",
        },
      );
      const logged = JSON.stringify(logger.error.mock.calls);
      expect(logged).not.toContain(authenticatedUser.accessToken);
      expect(logged).not.toContain(stableInput.id);
      expect(logged).not.toContain(stableInput.content);
      expect(logged).not.toContain("tool-1");
    },
  );

  it("maps non-duplicate insert failures to a safe server error", async () => {
    const db = messageDatabase({
      insertError: { code: "42501", message: "permission denied" },
    });

    await expect(
      messageService(db).createMessage(
        authenticatedUser,
        "session-1",
        stableInput,
      ),
    ).rejects.toMatchObject({ code: "chat_error", statusCode: 500 });

    expect(db.existingSelect).not.toHaveBeenCalled();
    expect(db.sessionUpdates).toEqual([]);
  });

  it("keeps legacy messages without an id on the plain insert path", async () => {
    const db = messageDatabase({
      insertData: persistedRow("session-1", {
        role: "user",
        content: "Legacy message.",
      }),
    });

    await messageService(db).createMessage(authenticatedUser, "session-1", {
      role: "user",
      content: "Legacy message.",
    });

    expect(db.insert).toHaveBeenCalledWith(
      expect.not.objectContaining({ id: expect.anything() }),
    );
    expect(db.upsert).not.toHaveBeenCalled();
  });
});

function messageService(
  db: ReturnType<typeof messageDatabase>,
  logger?: { error: ReturnType<typeof vi.fn> },
) {
  return createChatService({
    createUserClient: () => db.client,
    threadService: { createThreadId: () => "thread-1" },
    ...(logger ? { logger } : {}),
  });
}

function persistedRow(
  sessionId: string,
  input: {
    id?: string;
    role: "user" | "assistant";
    content: string;
    toolActivities?: unknown[];
    contentBlocks?: unknown[];
  },
) {
  return {
    id: input.id ?? "22222222-2222-4222-8222-222222222222",
    session_id: sessionId,
    role: input.role,
    content: input.content,
    tool_activities: input.toolActivities ?? null,
    content_blocks: input.contentBlocks ?? null,
    created_at: timestamp,
  };
}

function messageDatabase(options: {
  insertData?: ReturnType<typeof persistedRow>;
  insertError?: { code: string; message: string };
  existing?: ReturnType<typeof persistedRow>;
  existingError?: { code: string; message: string };
}) {
  const insert = vi.fn();
  const upsert = vi.fn();
  const existingSelect = vi.fn();
  const existingId = vi.fn();
  const sessionUpdates: unknown[] = [];
  let messageTableAccess = 0;
  const client = {
    from(table: string) {
      if (table === "chat_sessions") {
        const sessionQuery = {
          update(value: unknown) {
            sessionUpdates.push(value);
            return sessionQuery;
          },
          eq() {
            return sessionQuery;
          },
        };
        return sessionQuery;
      }
      messageTableAccess += 1;
      const query: Record<string, unknown> = {};
      query.insert = (value: unknown) => {
        insert(value);
        return query;
      };
      query.upsert = (value: unknown) => {
        upsert(value);
        return query;
      };
      query.select = (columns: string) => {
        if (messageTableAccess > 1) existingSelect(columns);
        return query;
      };
      query.eq = (column: string, value: unknown) => {
        existingId(column, value);
        return query;
      };
      query.single = async () => ({
        data: options.insertData ?? null,
        error: options.insertError ?? null,
      });
      query.maybeSingle = async () => ({
        data: options.existing ?? null,
        error: options.existingError ?? null,
      });
      return query;
    },
  };
  return {
    client: client as never,
    existingId,
    existingSelect,
    insert,
    sessionUpdates,
    upsert,
  };
}
