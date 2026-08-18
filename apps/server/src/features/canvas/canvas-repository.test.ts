import { describe, expect, it, vi } from "vitest";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import { createCanvasRepository } from "./canvas-repository.js";

const user: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  accessToken: "token",
  email: "",
  userMetadata: {},
};
const command = {
  canvasId: "22222222-2222-4222-8222-222222222222",
  expectedRevision: 3,
  content: { elements: [], appState: {}, files: {} },
  eventType: "canvas.updated",
  eventPayload: { source: "browser" },
};

describe("canvas repository", () => {
  it("commits revision 3 to 4 through the transactional RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: { revision: 4, replayed: false },
      error: null,
    }));
    const repository = createCanvasRepository({
      createUserClient: () => ({ rpc }) as unknown as UserSupabaseClient,
      getAdminClient: () =>
        ({ rpc: vi.fn() }) as unknown as AdminSupabaseClient,
    });
    await expect(repository.commit(user, command)).resolves.toEqual({
      revision: 4,
      replayed: false,
    });
    expect(rpc).toHaveBeenCalledWith("save_canvas_revision", {
      p_canvas_id: command.canvasId,
      p_expected_revision: 3,
      p_content: command.content,
    });
  });

  it("uses the service-role boundary for a Job effect commit", async () => {
    const userRpc = vi.fn();
    const adminRpc = vi.fn(async () => ({
      data: { revision: 4, replayed: false },
      error: null,
    }));
    const repository = createCanvasRepository({
      createUserClient: () =>
        ({ rpc: userRpc }) as unknown as UserSupabaseClient,
      getAdminClient: () =>
        ({ rpc: adminRpc }) as unknown as AdminSupabaseClient,
    });
    await repository.commit(user, {
      ...command,
      jobId: "33333333-3333-4333-8333-333333333333",
      effectKind: "generated_asset",
    });
    expect(userRpc).not.toHaveBeenCalled();
    expect(adminRpc).toHaveBeenCalledWith(
      "commit_canvas_revision",
      expect.objectContaining({
        p_actor_user_id: user.id,
        p_job_id: "33333333-3333-4333-8333-333333333333",
        p_effect_kind: "generated_asset",
      }),
    );
  });

  it("commits Agent canvas effects and fencing in one service-role RPC", async () => {
    const adminRpc = vi.fn(async () => ({
      data: { revision: 4, replayed: false },
      error: null,
    }));
    const repository = createCanvasRepository({
      createUserClient: () =>
        ({ rpc: vi.fn() }) as unknown as UserSupabaseClient,
      getAdminClient: () =>
        ({ rpc: adminRpc }) as unknown as AdminSupabaseClient,
    });
    await repository.commit(user, {
      ...command,
      agentEffect: {
        runId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        fencingToken: 7,
        logicalToolCallId: "tool-call-1",
        inputDigest: "digest-1",
        result: { applied: 1 },
      },
    });
    expect(adminRpc).toHaveBeenCalledWith(
      "commit_agent_canvas_revision",
      expect.objectContaining({
        p_run_id: "44444444-4444-4444-8444-444444444444",
        p_attempt_id: "55555555-5555-4555-8555-555555555555",
        p_fencing_token: 7,
        p_logical_tool_call_id: "tool-call-1",
        p_input_digest: "digest-1",
      }),
    );
  });

  it("maps a conflict to safe expected and current revisions", async () => {
    const repository = createCanvasRepository({
      createUserClient: () =>
        ({
          rpc: vi.fn(async () => ({
            data: null,
            error: {
              details: "canvas_revision_conflict",
              hint: JSON.stringify({ expectedRevision: 3, currentRevision: 5 }),
            },
          })),
        }) as unknown as UserSupabaseClient,
      getAdminClient: () =>
        ({ rpc: vi.fn() }) as unknown as AdminSupabaseClient,
    });
    await expect(repository.commit(user, command)).rejects.toMatchObject({
      code: "canvas_revision_conflict",
      statusCode: 409,
      details: { expectedRevision: 3, currentRevision: 5 },
    });
  });
});
