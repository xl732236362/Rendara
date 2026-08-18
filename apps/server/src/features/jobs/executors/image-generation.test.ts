import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateImageMock } = vi.hoisted(() => ({
  generateImageMock: vi.fn(),
}));

vi.mock("../../../generation/image-generation.js", () => ({
  generateImage: generateImageMock,
}));
vi.mock("../../credits/watermark.js", () => ({
  applyWatermark: vi.fn(async (buffer: Buffer) => buffer),
}));

import { createImageGenerationExecutor } from "./image-generation.js";

const ids = {
  asset: "66666666-6666-4666-8666-666666666666",
  generatedAsset: "77777777-7777-4777-8777-777777777777",
  job: "44444444-4444-4444-8444-444444444444",
  project: "33333333-3333-4333-8333-333333333333",
  user: "11111111-1111-4111-8111-111111111111",
  workspace: "22222222-2222-4222-8222-222222222222",
};

describe("image generation executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateImageMock.mockResolvedValue({
      url: "https://provider.test/output.png",
      width: 1024,
      height: 1024,
      mimeType: "image/png",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
    );
  });

  it("resolves reference assets and assigns the generated asset to the project", async () => {
    const generatedInsert = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => ({
          data: { id: ids.generatedAsset },
          error: null,
        })),
      })),
    }));
    const admin = {
      from: vi.fn((table: string) => {
        if (table === "background_jobs") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: {
                    created_by: ids.user,
                    workspace_id: ids.workspace,
                    project_id: ids.project,
                    canvas_id: null,
                    session_id: null,
                    payload: {
                      prompt: "draw",
                      model: "image/model",
                      input_asset_ids: [ids.asset],
                    },
                  },
                })),
              })),
            })),
          };
        }
        if (table === "subscriptions") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: { plan: "pro" } })),
              })),
            })),
          };
        }
        if (table === "asset_objects") {
          return {
            select: vi.fn(() => ({
              in: vi.fn(async () => ({
                data: [
                  {
                    id: ids.asset,
                    workspace_id: ids.workspace,
                    project_id: ids.project,
                    bucket: "project-assets",
                    object_path: `${ids.workspace}/${ids.project}/reference.png`,
                    mime_type: "image/png",
                  },
                ],
                error: null,
              })),
            })),
            insert: generatedInsert,
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: vi.fn(async () => ({
            data: { signedUrl: "https://storage.test/reference.png?token=x" },
            error: null,
          })),
          upload: vi.fn(async () => ({ error: null })),
          getPublicUrl: vi.fn(() => ({
            data: { publicUrl: "https://storage.test/generated.png" },
          })),
        })),
      },
    };
    const executor = createImageGenerationExecutor({
      resolveImageProviderName: vi.fn(() => "replicate"),
    } as never);

    await executor(ids.job, {}, {
      getAdminClient: () => admin,
      renewVt: vi.fn(),
    } as never);

    expect(generateImageMock).toHaveBeenCalledWith(
      expect.anything(),
      "replicate",
      expect.objectContaining({
        inputImages: ["https://storage.test/reference.png?token=x"],
      }),
    );
    expect(generatedInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: ids.project,
        generation_job_id: ids.job,
      }),
    );
  });
});
