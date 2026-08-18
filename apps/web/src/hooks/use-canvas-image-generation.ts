"use client";

import { useCallback, useEffect, useRef } from "react";

import { ApiApplicationError, ApiAuthError } from "../lib/api-client";
import {
  createExcalidrawImageElement,
  fetchAsDataURL,
} from "../lib/canvas-elements";
import {
  buildImageJobRequest,
  classifyImageJob,
  parseImageJobResult,
  validateImageJobContext,
} from "../lib/canvas-generation-reconciler";
import {
  getImageGeneratorData,
  isImageGeneratorElement,
  updateImageGeneratorAttempt,
  type ImageGeneratorData,
} from "../lib/canvas-image-generator";
import type { DurableSceneMutation } from "../lib/canvas-persistence";
import {
  fetchCanvas,
  fetchJob,
  getAssetUrl,
  submitImageJob,
} from "../lib/server-api";

type CanvasApi = {
  getSceneElements(): readonly any[];
  addFiles(files: any[]): void;
  onChange?(listener: () => void): (() => void) | void;
};

type StartAttemptFields = Pick<
  ImageGeneratorData,
  "prompt" | "model" | "aspectRatio" | "quality" | "referenceAssetIds"
>;

const INITIAL_POLL_MS = 1_000;
const MAX_POLL_MS = 15_000;

export function useCanvasImageGeneration(options: {
  accessToken: string;
  userId: string;
  projectId: string;
  canvasId: string;
  excalidrawApi: CanvasApi | null;
  durableMutation: DurableSceneMutation | null;
}) {
  const operationKeysRef = useRef(new Set<string>());
  const pollTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const recoveryTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const trackedAttemptsRef = useRef(new Map<string, string>());
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const findAttempt = useCallback((elementId: string, attemptKey: string) => {
    const element = optionsRef.current.excalidrawApi
      ?.getSceneElements()
      .find((candidate: any) => candidate.id === elementId);
    if (
      !element ||
      element.isDeleted ||
      !isImageGeneratorElement(element) ||
      element.customData.status !== "generating" ||
      element.customData.idempotencyKey !== attemptKey
    ) {
      return null;
    }
    return element;
  }, []);

  const mutateAttempt = useCallback(
    async (
      elementId: string,
      attemptKey: string,
      updates: Partial<ImageGeneratorData>,
    ) => {
      const mutation = optionsRef.current.durableMutation;
      if (!mutation) return { kind: "rejected" as const };
      return mutation((elements) =>
        elements.map((element: any) =>
          element.id === elementId && isImageGeneratorElement(element)
            ? updateImageGeneratorAttempt(element, attemptKey, updates)
            : element,
        ),
      );
    },
    [],
  );

  const markTerminalError = useCallback(
    async (elementId: string, attemptKey: string, message: string) => {
      await mutateAttempt(elementId, attemptKey, {
        status: "error",
        errorMessage: message,
      });
    },
    [mutateAttempt],
  );

  const applySuccess = useCallback(
    async (elementId: string, attemptKey: string, job: any) => {
      const current = findAttempt(elementId, attemptKey);
      if (
        !current ||
        (current.customData.jobId && current.customData.jobId !== job.id)
      )
        return true;
      let result;
      try {
        result = parseImageJobResult(job.result);
      } catch {
        await markTerminalError(elementId, attemptKey, "生成结果无效，请重试");
        return;
      }
      const { url } = await getAssetUrl(
        optionsRef.current.accessToken,
        result.assetId,
      );
      const dataURL = await fetchAsDataURL(url, optionsRef.current.accessToken);
      const live = findAttempt(elementId, attemptKey);
      if (!live || (live.customData.jobId && live.customData.jobId !== job.id))
        return true;

      const fileId = `generated-${result.assetId}`;
      optionsRef.current.excalidrawApi?.addFiles([
        {
          id: fileId,
          dataURL,
          mimeType: result.mimeType,
          created: Date.now(),
          assetId: result.assetId,
        },
      ]);
      const image = {
        ...createExcalidrawImageElement({
          fileId,
          x: live.x as number,
          y: live.y as number,
          width: live.width as number,
          height: live.height as number,
          angle: (live.angle as number | undefined) ?? 0,
          title: live.customData.prompt.slice(0, 60),
          source: "generated",
        }),
        groupIds: live.groupIds ?? [],
        frameId: live.frameId ?? null,
        index: live.index ?? null,
      };
      const saveResult = await optionsRef.current.durableMutation?.((elements) => {
        const latest = elements.find((element: any) => element.id === elementId);
        if (
          !latest ||
          (latest as any).isDeleted ||
          !isImageGeneratorElement(latest) ||
          latest.customData.idempotencyKey !== attemptKey ||
          (latest.customData.jobId && latest.customData.jobId !== job.id)
        ) {
          return [...elements];
        }
        return [
          ...elements.map((element: any) =>
            element.id === elementId ? { ...element, isDeleted: true } : element,
          ),
          image,
        ];
      });
      return saveResult?.kind === "committed";
    },
    [findAttempt, markTerminalError],
  );

  const pollJobRef = useRef<
    (elementId: string, attemptKey: string, jobId: string, delay?: number) => void
  >(() => undefined);
  pollJobRef.current = (elementId, attemptKey, jobId, delay = 0) => {
    if (!mountedRef.current || pollTimersRef.current.has(jobId)) return;
    const timer = setTimeout(async () => {
      pollTimersRef.current.delete(jobId);
      const current = findAttempt(elementId, attemptKey);
      if (
        !current ||
        (current.customData.jobId && current.customData.jobId !== jobId)
      )
        return;
      try {
        const { job } = await fetchJob(optionsRef.current.accessToken, jobId);
        const validation = validateImageJobContext(job, {
          jobId,
          projectId: optionsRef.current.projectId,
          canvasId: optionsRef.current.canvasId,
          userId: optionsRef.current.userId,
        });
        if (!validation.ok) {
          await markTerminalError(elementId, attemptKey, "任务上下文校验失败");
          return;
        }
        const disposition = classifyImageJob(job);
        if (disposition === "success") {
          const committed = await applySuccess(elementId, attemptKey, job);
          if (!committed) {
            pollJobRef.current(elementId, attemptKey, jobId, INITIAL_POLL_MS);
          }
          return;
        }
        if (disposition === "terminal-error") {
          await markTerminalError(
            elementId,
            attemptKey,
            job.error_message ?? "图片生成失败，请重试",
          );
          return;
        }
        pollJobRef.current(
          elementId,
          attemptKey,
          jobId,
          Math.min(delay ? delay * 2 : INITIAL_POLL_MS, MAX_POLL_MS),
        );
      } catch (error) {
        if (error instanceof ApiAuthError) return;
        if (error instanceof ApiApplicationError && error.status === 404) {
          const cleared = await optionsRef.current.durableMutation?.((elements) =>
            elements.map((candidate: any) => {
              if (
                candidate.id !== elementId ||
                !isImageGeneratorElement(candidate) ||
                candidate.customData.idempotencyKey !== attemptKey
              ) {
                return candidate;
              }
              const { jobId: _staleJobId, ...customData } = candidate.customData;
              return { ...candidate, customData };
            }),
          );
          if (cleared?.kind === "committed") {
            const replayable = findAttempt(elementId, attemptKey);
            if (replayable) void recoverElementRef.current(replayable);
          }
          return;
        }
        if (error instanceof ApiApplicationError && error.status === 403) {
          await markTerminalError(elementId, attemptKey, "任务访问校验失败");
          return;
        }
        pollJobRef.current(
          elementId,
          attemptKey,
          jobId,
          Math.min(delay ? delay * 2 : INITIAL_POLL_MS, MAX_POLL_MS),
        );
      }
    }, delay);
    pollTimersRef.current.set(jobId, timer);
  };

  const recoverElementRef = useRef<(element: any) => Promise<void>>(async () => undefined);
  recoverElementRef.current = async (element) => {
    const data = getImageGeneratorData(element);
    if (!data || data.status !== "generating") return;
    if (!data.idempotencyKey) {
      await optionsRef.current.durableMutation?.((elements) =>
        elements.map((candidate: any) =>
          candidate.id === element.id &&
          isImageGeneratorElement(candidate) &&
          candidate.customData.status === "generating" &&
          !candidate.customData.idempotencyKey
            ? {
                ...candidate,
                customData: {
                  ...candidate.customData,
                  status: "error",
                  errorMessage: "旧版生成任务无法恢复，请重试",
                },
              }
            : candidate,
        ),
      );
      return;
    }
    if (data.jobId) {
      pollJobRef.current(element.id, data.idempotencyKey, data.jobId);
      return;
    }
    const operationKey = `${element.id}:${data.idempotencyKey}`;
    if (operationKeysRef.current.has(operationKey)) return;
    operationKeysRef.current.add(operationKey);
    try {
      const body = buildImageJobRequest(data, {
        projectId: optionsRef.current.projectId,
        canvasId: optionsRef.current.canvasId,
      });
      const { job } = await submitImageJob(optionsRef.current.accessToken, body);
      if (!findAttempt(element.id, data.idempotencyKey)) return;
      pollJobRef.current(element.id, data.idempotencyKey, job.id);
      void mutateAttempt(element.id, data.idempotencyKey, { jobId: job.id });
    } catch (error) {
      if (
        error instanceof ApiApplicationError &&
        error.status >= 400 &&
        error.status < 500 &&
        !(error instanceof ApiAuthError)
      ) {
        await markTerminalError(element.id, data.idempotencyKey, "提交失败，请重试");
      } else if (!recoveryTimersRef.current.has(operationKey)) {
        const timer = setTimeout(() => {
          recoveryTimersRef.current.delete(operationKey);
          const current = findAttempt(element.id, data.idempotencyKey!);
          if (current) void recoverElementRef.current(current);
        }, INITIAL_POLL_MS);
        recoveryTimersRef.current.set(operationKey, timer);
      }
    } finally {
      operationKeysRef.current.delete(operationKey);
    }
  };

  const scan = useCallback(() => {
    if (!optionsRef.current.accessToken) return;
    const elements = optionsRef.current.excalidrawApi?.getSceneElements() ?? [];
    const byId = new Map(elements.map((element: any) => [element.id, element]));
    for (const [elementId, attemptKey] of trackedAttemptsRef.current) {
      const element = byId.get(elementId) as any;
      if (!element || element.isDeleted) {
        trackedAttemptsRef.current.delete(elementId);
        void optionsRef.current.durableMutation?.((current) => [...current]);
        console.info("[canvas-image-generation] persisted generator deletion", {
          canvasId: optionsRef.current.canvasId.slice(0, 8),
          elementId,
          attempt: attemptKey.slice(0, 8),
        });
      }
    }
    for (const element of elements) {
      if (
        !element.isDeleted &&
        isImageGeneratorElement(element) &&
        element.customData.status === "generating"
      ) {
        if (
          typeof element.id === "string" &&
          element.customData.idempotencyKey
        ) {
          trackedAttemptsRef.current.set(
            element.id,
            element.customData.idempotencyKey,
          );
        }
        void recoverElementRef.current(element);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    scan();
    const unsubscribe = options.excalidrawApi?.onChange?.(scan);
    return () => {
      mountedRef.current = false;
      unsubscribe?.();
      for (const timer of pollTimersRef.current.values()) clearTimeout(timer);
      pollTimersRef.current.clear();
      for (const timer of recoveryTimersRef.current.values()) clearTimeout(timer);
      recoveryTimersRef.current.clear();
      trackedAttemptsRef.current.clear();
      operationKeysRef.current.clear();
    };
  }, [options.excalidrawApi, options.accessToken, options.canvasId, scan]);

  const startAttempt = useCallback(
    async (elementId: string, fields: StartAttemptFields) => {
      const guard = `${elementId}:start`;
      if (operationKeysRef.current.has(guard)) return;
      operationKeysRef.current.add(guard);
      try {
        const current = optionsRef.current.excalidrawApi
          ?.getSceneElements()
          .find((element: any) => element.id === elementId);
        if (!current || current.isDeleted || !isImageGeneratorElement(current)) return;
        if (current.customData.status === "generating") return;
        const attemptKey = crypto.randomUUID();
        const result = await optionsRef.current.durableMutation?.((elements) =>
          elements.map((element: any) =>
            element.id === elementId && isImageGeneratorElement(element)
              ? {
                  ...element,
                  customData: {
                    ...element.customData,
                    ...fields,
                    status: "generating",
                    idempotencyKey: attemptKey,
                    jobId: undefined,
                    errorMessage: undefined,
                  },
                }
              : element,
          ),
        );
        if (result?.kind === "committed") scan();
        if (result?.kind === "ambiguous") {
          const { canvas } = await fetchCanvas(
            optionsRef.current.accessToken,
            optionsRef.current.canvasId,
          );
          const authoritative = (canvas.content as any).elements?.find(
            (element: any) => element.id === elementId,
          );
          if (authoritative?.customData?.idempotencyKey === attemptKey) scan();
        }
      } finally {
        operationKeysRef.current.delete(guard);
      }
    },
    [scan],
  );

  return { startAttempt, scan };
}
