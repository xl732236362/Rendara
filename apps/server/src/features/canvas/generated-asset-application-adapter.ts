import type { AttachGeneratedAssetCommand } from "../../application/canvas/attach-generated-asset.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import {
  insertImageElement,
  insertVideoElement,
  prepareImageDataURL,
} from "./canvas-element-writer.js";
import { createCanvasRepository } from "./canvas-repository.js";

export function createGeneratedAssetPort(options: {
  createUserClient(accessToken: string): UserSupabaseClient;
}) {
  const repository = createCanvasRepository(options);
  return {
    async attach(command: AttachGeneratedAssetCommand) {
      const user = {
        id: command.principal.userId,
        accessToken: command.principal.accessToken ?? "",
        email: "",
        userMetadata: {},
      };
      const client = options.createUserClient(user.accessToken);
      const imageDataURL =
        command.asset.type === "image"
          ? await prepareImageDataURL(
              client,
              command.asset.objectPath,
              command.asset.mimeType,
            )
          : undefined;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const canvas = await repository.read(user, command.canvasId);
        const inserted =
          command.asset.type === "image"
            ? insertImageElement(
                canvas.content,
                {
                  dataURL: imageDataURL!,
                  elementId: command.jobId,
                  fileId: `${command.jobId}-file`,
                  width: command.asset.width,
                  height: command.asset.height,
                  mimeType: command.asset.mimeType,
                  ...(command.asset.title
                    ? { title: command.asset.title }
                    : {}),
                },
                command.placement,
              )
            : insertVideoElement(
                canvas.content,
                {
                  signedUrl: command.asset.signedUrl,
                  elementId: command.jobId,
                  width: command.asset.width,
                  height: command.asset.height,
                  mimeType: command.asset.mimeType,
                  ...(command.asset.durationSeconds !== undefined
                    ? { durationSeconds: command.asset.durationSeconds }
                    : {}),
                },
                command.placement,
              );
        try {
          const committed = await repository.commit(user, {
            canvasId: command.canvasId,
            expectedRevision: canvas.revision,
            content: inserted.content,
            jobId: command.jobId,
            effectKind: command.effectKey,
            eventType: "canvas.generated_asset_attached",
            eventPayload: {
              canvasId: command.canvasId,
              jobId: command.jobId,
              elementId: inserted.elementId,
            },
          });
          return {
            elementId: inserted.elementId,
            replayed: committed.replayed,
          };
        } catch (error) {
          if (!isConflict(error) || attempt === 3) throw error;
        }
      }
      throw new Error("Generated asset Canvas commit retry exhausted.");
    },
  };
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "canvas_revision_conflict"
  );
}
