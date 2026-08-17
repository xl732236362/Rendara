import type {
  UserSupabaseClient,
  AuthenticatedUser,
} from "../../supabase/user.js";
import { createCanvasRepository } from "./canvas-repository.js";
import { describe, expect, it, vi } from "vitest";

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
    });
    await expect(repository.commit(user, command)).resolves.toEqual({
      revision: 4,
      replayed: false,
    });
    expect(rpc).toHaveBeenCalledWith(
      "commit_canvas_revision",
      expect.objectContaining({
        p_canvas_id: command.canvasId,
        p_actor_user_id: user.id,
        p_expected_revision: 3,
        p_job_id: null,
        p_effect_kind: null,
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
    });
    await expect(repository.commit(user, command)).rejects.toMatchObject({
      code: "canvas_revision_conflict",
      statusCode: 409,
      details: { expectedRevision: 3, currentRevision: 5 },
    });
  });
});
