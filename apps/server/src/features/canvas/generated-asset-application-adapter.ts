import type { AttachGeneratedAssetCommand } from "../../application/canvas/attach-generated-asset.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import {
  insertImageElement,
  insertVideoElement,
} from "./canvas-element-writer.js";

export function createGeneratedAssetPort(options: {
  createUserClient(accessToken: string): UserSupabaseClient;
}) {
  return {
    async attach(command: AttachGeneratedAssetCommand) {
      const client = options.createUserClient(
        command.principal.accessToken ?? "",
      );
      return command.asset.type === "image"
        ? insertImageElement(
            client,
            {
              canvasId: command.canvasId,
              objectPath: command.asset.objectPath,
              width: command.asset.width,
              height: command.asset.height,
              mimeType: command.asset.mimeType,
              ...(command.asset.title ? { title: command.asset.title } : {}),
            },
            command.placement,
          )
        : insertVideoElement(
            client,
            {
              canvasId: command.canvasId,
              signedUrl: command.asset.signedUrl,
              width: command.asset.width,
              height: command.asset.height,
              mimeType: command.asset.mimeType,
              ...(command.asset.durationSeconds !== undefined
                ? { durationSeconds: command.asset.durationSeconds }
                : {}),
            },
            command.placement,
          );
    },
  };
}
