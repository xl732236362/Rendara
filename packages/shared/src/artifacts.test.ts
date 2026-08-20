import { describe, expect, it } from "vitest";
import {
  generatedAssetAttachmentStatusSchema,
  generatedAssetRecoverySchema,
  imageArtifactSchema,
} from "./artifacts.js";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  job: "22222222-2222-4222-8222-222222222222",
};

describe("imageArtifactSchema", () => {
  it("accepts artifact with placement coordinates", () => {
    const result = imageArtifactSchema.parse({
      type: "image",
      url: "https://example.com/img.png",
      mimeType: "image/png",
      width: 512,
      height: 512,
      placement: { x: 100, y: 200, width: 512, height: 512 },
    });
    expect(result.placement).toEqual({
      x: 100,
      y: 200,
      width: 512,
      height: 512,
    });
  });

  it("succeeds without placement (backward compat)", () => {
    const result = imageArtifactSchema.parse({
      type: "image",
      url: "https://example.com/img.png",
      mimeType: "image/png",
      width: 512,
      height: 512,
    });
    expect(result.placement).toBeUndefined();
  });

  it.each(["data:image/png;base64,abc", "file:///tmp/image.png"])(
    "rejects unsafe display URL %s",
    (url) => {
      expect(() =>
        imageArtifactSchema.parse({
          type: "image",
          url,
          mimeType: "image/png",
          width: 512,
          height: 512,
        }),
      ).toThrow();
    },
  );
});

describe("generated asset recovery contracts", () => {
  it("accepts only bounded authenticated recovery descriptors", () => {
    expect(
      generatedAssetRecoverySchema.parse({
        kind: "attach_generated_asset",
        jobId: ids.job,
        canvasId: ids.canvas,
      }),
    ).toEqual({
      kind: "attach_generated_asset",
      jobId: ids.job,
      canvasId: ids.canvas,
    });
    expect(() =>
      generatedAssetRecoverySchema.parse({
        kind: "open_url",
        jobId: ids.job,
        canvasId: ids.canvas,
        url: "https://example.com/private",
      }),
    ).toThrow();
  });

  it("requires durable attachment proof for attached outcomes", () => {
    expect(() =>
      generatedAssetAttachmentStatusSchema.parse({
        attachmentStatus: "attached",
        jobId: ids.job,
      }),
    ).toThrow();
    expect(
      generatedAssetAttachmentStatusSchema.parse({
        attachmentStatus: "attached",
        jobId: ids.job,
        elementId: ids.job,
        canvasRevision: 3,
      }),
    ).toMatchObject({ elementId: ids.job, canvasRevision: 3 });
  });

  it("requires watch recovery for a pending attachment", () => {
    expect(
      generatedAssetAttachmentStatusSchema.parse({
        attachmentStatus: "pending",
        jobId: ids.job,
        recovery: {
          kind: "watch_generated_asset",
          jobId: ids.job,
          canvasId: ids.canvas,
        },
        error: {
          code: "generated_asset_pending",
          message: "Attachment is continuing in the background.",
          retryable: true,
        },
      }),
    ).toMatchObject({ attachmentStatus: "pending" });
  });
});
