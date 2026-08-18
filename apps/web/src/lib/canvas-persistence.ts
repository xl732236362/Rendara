import { ApiApplicationError, ApiTimeoutError } from "./api-client";

export type CanvasContent = {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, Record<string, unknown>>;
};

export type DurableSceneMutationResult =
  | { kind: "committed" }
  | { kind: "rejected" }
  | { kind: "ambiguous" };

export type DurableSceneMutation = (
  mutate: (
    elements: readonly Record<string, unknown>[],
  ) => Record<string, unknown>[],
) => Promise<DurableSceneMutationResult>;

export function serializeCanvasFiles(
  rawFiles: Record<string, Record<string, any>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(rawFiles).map(([id, file]) => [
      id,
      file.assetId
        ? {
            id: file.id,
            mimeType: file.mimeType,
            created: file.created,
            assetId: file.assetId,
          }
        : {
            id: file.id,
            dataURL: file.dataURL,
            mimeType: file.mimeType,
            created: file.created,
          },
    ]),
  );
}

export function createDurableSceneMutation(options: {
  cancelPendingSave(): void;
  getSceneElements(): readonly Record<string, unknown>[];
  updateScene(elements: Record<string, unknown>[]): void;
  buildContent(elements: Record<string, unknown>[]): CanvasContent;
  enqueueSave(content: CanvasContent): Promise<unknown>;
}): DurableSceneMutation {
  return async (mutate) => {
    options.cancelPendingSave();
    const nextElements = mutate(options.getSceneElements());
    options.updateScene(nextElements);
    const content = options.buildContent(nextElements);
    try {
      await options.enqueueSave(content);
      return { kind: "committed" };
    } catch (error) {
      if (
        error instanceof ApiTimeoutError ||
        (error instanceof ApiApplicationError && error.status >= 500)
      ) {
        return { kind: "ambiguous" };
      }
      return { kind: "rejected" };
    }
  };
}
