import { describe, expect, it, vi } from "vitest";

import type { GenerationPrincipal } from "./ports.js";
import { createReferenceAssetAuthorizationPort } from "./reference-assets.js";

const principal: GenerationPrincipal = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  accessToken: "token",
};
const projectId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";

function setup(rows: Array<Record<string, unknown>>) {
  const inQuery = vi.fn(async () => ({ data: rows, error: null }));
  const select = vi.fn(() => ({ in: inQuery }));
  const from = vi.fn(() => ({ select }));
  const createUserClient = vi.fn(() => ({ from }));
  return {
    createUserClient,
    inQuery,
    port: createReferenceAssetAuthorizationPort({
      createUserClient: createUserClient as never,
    }),
  };
}

describe("reference asset authorization", () => {
  it("accepts image assets in the requested workspace and project", async () => {
    const { inQuery, port } = setup([
      {
        id: assetId,
        workspace_id: principal.workspaceId,
        project_id: projectId,
        mime_type: "image/png",
      },
    ]);

    await expect(
      port.authorize({ principal, projectId, assetIds: [assetId] }),
    ).resolves.toBeUndefined();
    expect(inQuery).toHaveBeenCalledWith("id", [assetId]);
  });

  it("rejects duplicate asset ids before querying", async () => {
    const { inQuery, port } = setup([]);

    await expect(
      port.authorize({ principal, projectId, assetIds: [assetId, assetId] }),
    ).rejects.toMatchObject({ code: "invalid_request", statusCode: 400 });
    expect(inQuery).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [[
      {
        id: assetId,
        workspace_id: "55555555-5555-4555-8555-555555555555",
        project_id: projectId,
        mime_type: "image/png",
      },
    ]],
    [[
      {
        id: assetId,
        workspace_id: principal.workspaceId,
        project_id: "55555555-5555-4555-8555-555555555555",
        mime_type: "image/png",
      },
    ]],
    [[
      {
        id: assetId,
        workspace_id: principal.workspaceId,
        project_id: projectId,
        mime_type: "video/mp4",
      },
    ]],
  ])("rejects unavailable or invalid reference rows %#", async (rows) => {
    const { port } = setup(rows);

    await expect(
      port.authorize({ principal, projectId, assetIds: [assetId] }),
    ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
  });
});
