import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../supabase/user.js";
import { createResourceAuthorization } from "./resource-authorization.js";

const user: AuthenticatedUser = {
  accessToken: "user-token",
  email: "designer@example.com",
  id: "user-1",
  userMetadata: {},
};

describe("resource authorization", () => {
  it("allows a canvas visible through the user-scoped client", async () => {
    const authorization = createResourceAuthorization({
      createUserClient: () =>
        fakeClient({ canvases: { id: "canvas-1" } }) as never,
      findRunSessionId: async () => null,
    });

    await expect(
      authorization.requireCanvasAccess(user, "canvas-1"),
    ).resolves.toBeUndefined();
  });

  it("rejects an inaccessible canvas without revealing whether it exists", async () => {
    const authorization = createResourceAuthorization({
      createUserClient: () => fakeClient({}) as never,
      findRunSessionId: async () => null,
    });

    await expect(
      authorization.requireCanvasAccess(user, "other-canvas"),
    ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
  });

  it("returns the canvas for an accessible session", async () => {
    const authorization = createResourceAuthorization({
      createUserClient: () =>
        fakeClient({
          chat_sessions: { id: "session-1", canvas_id: "canvas-1" },
        }) as never,
      findRunSessionId: async () => null,
    });

    await expect(
      authorization.requireSessionAccess(user, "session-1"),
    ).resolves.toEqual({ canvasId: "canvas-1" });
  });

  it("authorizes a run only through its user-visible session", async () => {
    const authorization = createResourceAuthorization({
      createUserClient: () =>
        fakeClient({
          chat_sessions: { id: "session-1", canvas_id: "canvas-1" },
        }) as never,
      findRunSessionId: async (runId) =>
        runId === "run-1" ? "session-1" : null,
    });

    await expect(
      authorization.requireRunAccess(user, "run-1"),
    ).resolves.toEqual({ canvasId: "canvas-1" });
    await expect(
      authorization.requireRunAccess(user, "other-run"),
    ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
  });
});

function fakeClient(rows: Record<string, Record<string, unknown>>) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                async single() {
                  const data = rows[table] ?? null;
                  return {
                    data,
                    error: data ? null : { code: "PGRST116" },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}
