import { describe, expect, it } from "vitest";

import { queryKeys } from "./keys";

describe("queryKeys", () => {
  it("scopes authenticated resources by user and workspace", () => {
    expect(queryKeys.workspace.projects("user-1", "workspace-1", {})).toEqual([
      "users",
      "user-1",
      "workspaces",
      "workspace-1",
      "projects",
      {},
    ]);
    expect(
      queryKeys.workspace.creditTransactions("user-1", "workspace-1", {}),
    ).toEqual([
      "users",
      "user-1",
      "workspaces",
      "workspace-1",
      "credits",
      "transactions",
      {},
    ]);
  });

  it("scopes chat resources by canvas or session", () => {
    expect(
      queryKeys.workspace.canvas("user-1", "workspace-1", "canvas-1"),
    ).toEqual([
      "users",
      "user-1",
      "workspaces",
      "workspace-1",
      "canvases",
      "canvas-1",
    ]);
    expect(
      queryKeys.workspace.chatSessions("user-1", "workspace-1", "canvas-1", {}),
    ).toContain("canvas-1");
    expect(
      queryKeys.workspace.chatMessages(
        "user-1",
        "workspace-1",
        "canvas-1",
        "session-1",
        {},
      ),
    ).toEqual(expect.arrayContaining(["canvas-1", "session-1", "messages"]));
  });

  it("keeps anonymous and authenticated media catalogs separate", () => {
    expect(queryKeys.public.models.image({})).not.toEqual(
      queryKeys.workspace.models.image("user-1", "workspace-1", {}),
    );
    expect(queryKeys.public.models.video({})).not.toEqual(
      queryKeys.workspace.models.video("user-1", "workspace-1", {}),
    );
    expect(queryKeys.public.models.agent).toEqual([
      "public",
      "models",
      "agent",
    ]);
  });

  it("normalizes filters deterministically", () => {
    const first = queryKeys.workspace.projects("user-1", "workspace-1", {
      search: "  launch  ",
      tags: ["video", "image", "video"],
      ignored: undefined,
    });
    const second = queryKeys.workspace.projects("user-1", "workspace-1", {
      tags: ["image", "video"],
      search: "launch",
    });

    expect(first).toEqual(second);
  });
});
