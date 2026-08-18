import { describe, expect, it } from "vitest";

import {
  buildImageJobRequest,
  classifyImageJob,
  parseImageJobResult,
  validateImageJobContext,
} from "../src/lib/canvas-generation-reconciler";

const ids = {
  asset: "66666666-6666-4666-8666-666666666666",
  canvas: "33333333-3333-4333-8333-333333333333",
  job: "44444444-4444-4444-8444-444444444444",
  project: "22222222-2222-4222-8222-222222222222",
  user: "11111111-1111-4111-8111-111111111111",
};

const generator = {
  type: "image-generator" as const,
  status: "generating" as const,
  prompt: "draw",
  model: "image/model",
  aspectRatio: "16:9",
  quality: "hd",
  referenceAssetIds: [ids.asset],
  idempotencyKey: "attempt-1",
};

const job = {
  id: ids.job,
  project_id: ids.project,
  canvas_id: ids.canvas,
  created_by: ids.user,
  job_type: "image_generation",
  status: "queued",
};

describe("canvas generation reconciliation rules", () => {
  it("builds a replayable snake-case image job request", () => {
    expect(
      buildImageJobRequest(generator, {
        projectId: ids.project,
        canvasId: ids.canvas,
      }),
    ).toEqual({
      idempotency_key: "attempt-1",
      project_id: ids.project,
      canvas_id: ids.canvas,
      prompt: "draw",
      model: "image/model",
      aspect_ratio: "16:9",
      quality: "hd",
      input_asset_ids: [ids.asset],
    });
  });

  it.each([
    ["queued", "poll"],
    ["running", "poll"],
    ["failed", "poll"],
    ["cancel_requested", "poll"],
    ["succeeded", "success"],
    ["dead_letter", "terminal-error"],
    ["canceled", "terminal-error"],
  ] as const)("classifies %s as %s", (status, expected) => {
    expect(classifyImageJob({ status })).toBe(expected);
  });

  it("rejects a job outside the active user, project, canvas, type, or ID", () => {
    const context = {
      jobId: ids.job,
      projectId: ids.project,
      canvasId: ids.canvas,
      userId: ids.user,
    };
    expect(validateImageJobContext(job, context)).toEqual({ ok: true });

    for (const mismatch of [
      { id: "55555555-5555-4555-8555-555555555555" },
      { project_id: null },
      { canvas_id: null },
      { created_by: "55555555-5555-4555-8555-555555555555" },
      { job_type: "video_generation" },
    ]) {
      expect(validateImageJobContext({ ...job, ...mismatch }, context)).toEqual({
        ok: false,
        code: "job_context_mismatch",
      });
    }
  });

  it("accepts only asset-backed image results with positive dimensions", () => {
    expect(
      parseImageJobResult({
        asset_id: ids.asset,
        mime_type: "image/png",
        width: 1024,
        height: 576,
      }),
    ).toEqual({
      assetId: ids.asset,
      mimeType: "image/png",
      width: 1024,
      height: 576,
    });

    expect(() =>
      parseImageJobResult({
        asset_id: ids.asset,
        mime_type: "text/plain",
        width: 1024,
        height: 576,
      }),
    ).toThrow("Invalid image job result");
  });
});
