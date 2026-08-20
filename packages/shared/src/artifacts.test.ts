import { describe, expect, it } from "vitest";
import {
  boundedToolArtifactsSchema,
  generatedAssetAttachmentStatusSchema,
  generatedAssetRecoverySchema,
  imageArtifactSchema,
} from "./artifacts.js";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  job: "22222222-2222-4222-8222-222222222222",
};

describe("imageArtifactSchema", () => {
  it("normalizes supported image source wire forms", () => {
    const assetId = "11111111-1111-4111-8111-111111111111";
    const baseArtifact = {
      type: "image" as const,
      mimeType: "image/png",
      width: 512,
      height: 512,
    };

    const transitionArtifact = imageArtifactSchema.parse({
      ...baseArtifact,
      assetId,
    });

    expect(transitionArtifact).toMatchObject({
      source: { kind: "asset", assetId },
      url: `/api/assets/${assetId}`,
    });
    expect(transitionArtifact).not.toHaveProperty("assetId");
    expect(
      imageArtifactSchema.parse({
        ...baseArtifact,
        source: { kind: "asset", assetId },
      }),
    ).toMatchObject({
      source: { kind: "asset", assetId },
      url: `/api/assets/${assetId}`,
    });
    expect(
      imageArtifactSchema.parse({
        ...baseArtifact,
        url: `/api/assets/${assetId}`,
      }),
    ).toMatchObject({
      source: { kind: "asset", assetId },
      url: `/api/assets/${assetId}`,
    });
    expect(
      imageArtifactSchema.parse({
        ...baseArtifact,
        source: { kind: "external", url: "https://example.com/image.png" },
      }),
    ).toMatchObject({
      source: { kind: "external", url: "https://example.com/image.png" },
      url: "https://example.com/image.png",
    });
    expect(
      imageArtifactSchema.parse({
        ...baseArtifact,
        url: "https://example.com/legacy-image.png",
      }),
    ).toMatchObject({
      source: {
        kind: "external",
        url: "https://example.com/legacy-image.png",
      },
      url: "https://example.com/legacy-image.png",
    });
  });

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

  it("normalizes a legacy asset route containing the nil UUID", () => {
    const assetId = "00000000-0000-0000-0000-000000000000";

    expect(
      imageArtifactSchema.parse({
        type: "image",
        url: `/api/assets/${assetId}`,
        mimeType: "image/png",
        width: 512,
        height: 512,
      }),
    ).toMatchObject({
      source: { kind: "asset", assetId },
      url: `/api/assets/${assetId}`,
    });
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

describe("boundedToolArtifactsSchema", () => {
  it("drops invalid images before enforcing the valid artifact limit", () => {
    const validArtifacts = Array.from({ length: 10 }, (_, index) => ({
      type: "video" as const,
      url: `https://example.com/generated-${index}.mp4`,
      mimeType: "video/mp4",
      width: 1920,
      height: 1080,
    }));
    const invalidImage = {
      type: "image" as const,
      source: {
        kind: "asset" as const,
        assetId: "11111111-1111-4111-8111-111111111111",
      },
      url: "https://example.com/conflicting-image.png",
      mimeType: "image/png",
      width: 512,
      height: 512,
    };

    expect(
      boundedToolArtifactsSchema(10).parse([...validArtifacts, invalidImage]),
    ).toHaveLength(10);
    expect(() =>
      boundedToolArtifactsSchema(10).parse([
        ...validArtifacts,
        validArtifacts[0],
      ]),
    ).toThrow();
  });
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
