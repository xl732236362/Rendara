import { z } from "zod";
import type { CanvasOperationPrincipal } from "./apply-canvas-operations.js";

const placementSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
const requestSchema = z.object({
  canvasId: z.string().min(1),
  jobId: z.string().uuid(),
  effectKey: z.string().trim().min(1).max(100),
  placement: placementSchema.optional(),
  asset: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("image"),
      objectPath: z.string().min(1),
      width: z.number().positive(),
      height: z.number().positive(),
      mimeType: z.string().min(1),
      title: z.string().optional(),
    }),
    z.object({
      type: z.literal("video"),
      signedUrl: z.url(),
      width: z.number().positive(),
      height: z.number().positive(),
      mimeType: z.string().min(1),
      durationSeconds: z.number().nonnegative().optional(),
    }),
  ]),
});

export type AttachGeneratedAssetCommand = z.infer<typeof requestSchema> & {
  principal: CanvasOperationPrincipal;
};
export type AttachGeneratedAsset = ReturnType<
  typeof createAttachGeneratedAsset
>;

export function createAttachGeneratedAsset(options: {
  authorization: {
    requireCanvasAccess(
      principal: CanvasOperationPrincipal,
      canvasId: string,
    ): Promise<void>;
  };
  assets: {
    attach(
      command: AttachGeneratedAssetCommand,
    ): Promise<{ elementId: string }>;
  };
}) {
  return async (principal: CanvasOperationPrincipal, rawRequest: unknown) => {
    const request = requestSchema.parse(rawRequest);
    await options.authorization.requireCanvasAccess(
      principal,
      request.canvasId,
    );
    return options.assets.attach({ principal, ...request });
  };
}
