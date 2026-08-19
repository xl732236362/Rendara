import {
  ApiApplicationError,
  ApiAuthError,
  ApiTimeoutError,
} from "./api-client";

export type CanvasContent = {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, Record<string, unknown>>;
};

export type CanvasPersistenceSnapshot = {
  revision: number;
  content: CanvasContent;
  fingerprint: string;
};

type PendingCanvasSnapshot = Omit<CanvasPersistenceSnapshot, "revision">;

export type CanvasPersistenceState = {
  base: CanvasPersistenceSnapshot;
  pending: PendingCanvasSnapshot | null;
  inFlight: PendingCanvasSnapshot | null;
  live: PendingCanvasSnapshot;
  conflict: boolean;
  stopped: boolean;
};

type CanvasCommitNotice = {
  origin: "local" | "remote";
  revision: number;
  content: CanvasContent;
};

type CanvasPersistenceCoordinatorOptions = {
  initial: { revision: number; content: CanvasContent };
  save(input: {
    expectedRevision: number;
    content: CanvasContent;
    fingerprint: string;
  }): Promise<{ revision: number }>;
  fetch(): Promise<{ revision: number; content: CanvasContent }>;
  applyRemote(content: CanvasContent): void | Promise<void>;
  onConflict(input: {
    reason: CanvasMergeConflictReason | "revision_not_visible";
    baseRevision: number;
    remoteRevision?: number;
  }): void;
  onCommitted(notice: CanvasCommitNotice): void;
  getLiveContent?: () => CanvasContent;
};

export type CanvasMergeConflictReason =
  | "remote_changed_base"
  | "remote_reordered_base"
  | "remote_changed_app_state"
  | "remote_id_collision";

export type CanvasMergeResult =
  | { kind: "merged"; content: CanvasContent }
  | { kind: "conflict"; reason: CanvasMergeConflictReason };

export function normalizeDurableCanvasContent(
  content: CanvasContent,
): CanvasContent {
  return {
    elements: content.elements.filter((element) => !element.isDeleted),
    appState: {
      ...(content.appState.viewBackgroundColor !== undefined
        ? { viewBackgroundColor: content.appState.viewBackgroundColor }
        : {}),
      ...(content.appState.gridModeEnabled !== undefined
        ? { gridModeEnabled: content.appState.gridModeEnabled }
        : {}),
    },
    files: serializeCanvasFiles(content.files),
  };
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalJson(child)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function fingerprintCanvasContent(
  content: CanvasContent,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(content));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createCanvasDirtySignatureFactory() {
  const objectIds = new WeakMap<object, number>();
  let nextObjectId = 1;
  const identity = (value: unknown) => {
    if (value === null || typeof value !== "object") return 0;
    let id = objectIds.get(value);
    if (id === undefined) {
      id = nextObjectId;
      nextObjectId += 1;
      objectIds.set(value, id);
    }
    return id;
  };

  return (content: CanvasContent): string => {
    const elements = content.elements.map((element) => [
      identity(element),
      element.id,
      element.version,
      element.versionNonce,
      element.isDeleted === true,
    ]);
    const files = Object.entries(content.files)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, file]) => [
        id,
        identity(file),
        file.id,
        file.assetId,
        file.mimeType,
        file.created,
      ]);
    return canonicalJson({
      elements,
      appState: {
        viewBackgroundColor: content.appState.viewBackgroundColor,
        gridModeEnabled: content.appState.gridModeEnabled,
      },
      files,
    });
  };
}

export function mergeAppendOnlyRemoteContent(input: {
  base: CanvasContent;
  local: CanvasContent;
  remote: CanvasContent;
}): CanvasMergeResult {
  const base = normalizeDurableCanvasContent(input.base);
  const local = normalizeDurableCanvasContent(input.local);
  const remote = normalizeDurableCanvasContent(input.remote);
  const baseElements = new Map(
    base.elements.map((element) => [String(element.id), element]),
  );
  const localElements = new Map(
    local.elements.map((element) => [String(element.id), element]),
  );

  for (let index = 0; index < base.elements.length; index += 1) {
    const baseElement = base.elements[index];
    const remoteElement = remote.elements[index];
    if (!remoteElement || remoteElement.id !== baseElement?.id) {
      return { kind: "conflict", reason: "remote_reordered_base" };
    }
    if (canonicalJson(remoteElement) !== canonicalJson(baseElement)) {
      return { kind: "conflict", reason: "remote_changed_base" };
    }
  }

  if (canonicalJson(remote.appState) !== canonicalJson(base.appState)) {
    return { kind: "conflict", reason: "remote_changed_app_state" };
  }

  const mergedElements = [...local.elements];
  for (const remoteElement of remote.elements.slice(base.elements.length)) {
    const id = String(remoteElement.id);
    if (baseElements.has(id)) {
      return { kind: "conflict", reason: "remote_reordered_base" };
    }
    const localElement = localElements.get(id);
    if (localElement) {
      if (canonicalJson(localElement) !== canonicalJson(remoteElement)) {
        return { kind: "conflict", reason: "remote_id_collision" };
      }
      continue;
    }
    mergedElements.push(remoteElement);
  }

  const mergedFiles = { ...local.files };
  for (const [id, baseFile] of Object.entries(base.files)) {
    const remoteFile = remote.files[id];
    if (!remoteFile || canonicalJson(remoteFile) !== canonicalJson(baseFile)) {
      return { kind: "conflict", reason: "remote_changed_base" };
    }
  }
  for (const [id, remoteFile] of Object.entries(remote.files)) {
    if (base.files[id]) continue;
    const localFile = local.files[id];
    if (localFile && canonicalJson(localFile) !== canonicalJson(remoteFile)) {
      return { kind: "conflict", reason: "remote_id_collision" };
    }
    if (!localFile) mergedFiles[id] = remoteFile;
  }

  return {
    kind: "merged",
    content: {
      elements: mergedElements,
      appState: local.appState,
      files: mergedFiles,
    },
  };
}

export function createCanvasPersistenceCoordinator(
  options: CanvasPersistenceCoordinatorOptions,
) {
  const initialContent = normalizeDurableCanvasContent(options.initial.content);
  let state: CanvasPersistenceState = {
    base: {
      revision: options.initial.revision,
      content: initialContent,
      fingerprint: "",
    },
    pending: null,
    inFlight: null,
    live: { content: initialContent, fingerprint: "" },
    conflict: false,
    stopped: false,
  };
  let queue = Promise.resolve();
  let initialized: Promise<void> | null = null;

  function ensureInitialized() {
    initialized ??= fingerprintCanvasContent(initialContent).then(
      (fingerprint) => {
        state = {
          ...state,
          base: { ...state.base, fingerprint },
          live: { ...state.live, fingerprint },
        };
      },
    );
    return initialized;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      if (state.stopped) return undefined as T;
      await ensureInitialized();
      if (state.stopped) return undefined as T;
      try {
        return await operation();
      } catch (error) {
        if (error instanceof ApiAuthError) stop();
        throw error;
      }
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function stop() {
    if (state.stopped) return;
    state = {
      ...state,
      pending: null,
      inFlight: null,
      stopped: true,
    };
  }

  async function toPending(
    content: CanvasContent,
  ): Promise<PendingCanvasSnapshot> {
    const normalized = normalizeDurableCanvasContent(content);
    return {
      content: normalized,
      fingerprint: await fingerprintCanvasContent(normalized),
    };
  }

  function acceptBase(
    snapshot: CanvasPersistenceSnapshot,
    origin: CanvasCommitNotice["origin"],
  ) {
    state = {
      ...state,
      base: snapshot,
      pending:
        state.pending?.fingerprint === snapshot.fingerprint
          ? null
          : state.pending,
    };
    options.onCommitted({
      origin,
      revision: snapshot.revision,
      content: snapshot.content,
    });
  }

  async function readAuthoritative() {
    const fetched = await options.fetch();
    const content = normalizeDurableCanvasContent(fetched.content);
    return {
      revision: fetched.revision,
      content,
      fingerprint: await fingerprintCanvasContent(content),
    };
  }

  async function persist(pending: PendingCanvasSnapshot) {
    if (state.conflict) return;
    state = { ...state, pending: null, inFlight: pending };
    try {
      const saved = await options.save({
        expectedRevision: state.base.revision,
        content: pending.content,
        fingerprint: pending.fingerprint,
      });
      acceptBase({ ...pending, revision: saved.revision }, "local");
    } catch (error) {
      if (isAmbiguousSaveError(error)) {
        const authoritative = await readAuthoritative();
        if (authoritative.fingerprint === pending.fingerprint) {
          acceptBase(authoritative, "local");
          return;
        }
      }
      if (isRevisionConflict(error)) {
        const remote = await readAuthoritative();
        if (remote.fingerprint === pending.fingerprint) {
          acceptBase(remote, "local");
          return;
        }
        const merged = mergeAppendOnlyRemoteContent({
          base: state.base.content,
          local: pending.content,
          remote: remote.content,
        });
        if (merged.kind === "conflict") {
          state = { ...state, conflict: true, pending };
          options.onConflict({
            reason: merged.reason,
            baseRevision: state.base.revision,
            remoteRevision: remote.revision,
          });
          return;
        }
        const mergedPending = await toPending(merged.content);
        await options.applyRemote(mergedPending.content);
        state = {
          ...state,
          base: remote,
          live: mergedPending,
          pending: null,
        };
        options.onCommitted({
          origin: "remote",
          revision: remote.revision,
          content: remote.content,
        });
        await persist(mergedPending);
        return;
      }
      state = { ...state, pending };
      throw error;
    } finally {
      state = { ...state, inFlight: null };
    }
  }

  async function currentLiveSnapshot() {
    if (!options.getLiveContent) return state.live;
    return toPending(options.getLiveContent());
  }

  async function synchronize(targetRevision?: number) {
    if (state.conflict) return;
    if (targetRevision !== undefined && targetRevision <= state.base.revision) {
      return;
    }
    const remote = await readAuthoritative();
    if (targetRevision !== undefined && remote.revision < targetRevision) {
      state = { ...state, conflict: true };
      options.onConflict({
        reason: "revision_not_visible",
        baseRevision: state.base.revision,
        remoteRevision: remote.revision,
      });
      throw new Error("canvas_sync_revision_not_visible");
    }
    if (remote.revision <= state.base.revision) return;

    const live = await currentLiveSnapshot();
    const localIsClean = live.fingerprint === state.base.fingerprint;
    if (localIsClean) {
      await options.applyRemote(remote.content);
      state = { ...state, live: remote, pending: null };
      acceptBase(remote, "remote");
      return;
    }

    const merged = mergeAppendOnlyRemoteContent({
      base: state.base.content,
      local: live.content,
      remote: remote.content,
    });
    if (merged.kind === "conflict") {
      state = { ...state, conflict: true, live };
      options.onConflict({
        reason: merged.reason,
        baseRevision: state.base.revision,
        remoteRevision: remote.revision,
      });
      return;
    }

    const mergedPending = await toPending(merged.content);
    await options.applyRemote(mergedPending.content);
    state = { ...state, base: remote, live: mergedPending, pending: null };
    options.onCommitted({
      origin: "remote",
      revision: remote.revision,
      content: remote.content,
    });
    if (mergedPending.fingerprint !== remote.fingerprint) {
      await persist(mergedPending);
    }
  }

  return {
    observe(content: CanvasContent) {
      return enqueue(async () => {
        const live = await toPending(content);
        state = { ...state, live };
        if (
          state.conflict ||
          live.fingerprint === state.base.fingerprint ||
          live.fingerprint === state.inFlight?.fingerprint
        ) {
          return;
        }
        if (live.fingerprint === state.pending?.fingerprint) {
          await persist(state.pending);
          return;
        }
        state = { ...state, pending: live };
        await persist(live);
      });
    },
    syncToRevision(revision: number) {
      return enqueue(() => synchronize(revision));
    },
    reconcile() {
      return enqueue(() => synchronize());
    },
    pendingUnload(): CanvasContent | null {
      if (
        state.stopped ||
        state.conflict ||
        !state.live.fingerprint ||
        state.live.fingerprint === state.base.fingerprint
      ) {
        return null;
      }
      return state.live.content;
    },
    snapshot(): CanvasPersistenceState {
      return state;
    },
  };
}

function isAmbiguousSaveError(error: unknown): boolean {
  return (
    error instanceof ApiTimeoutError ||
    (error instanceof ApiApplicationError && error.status >= 500)
  );
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof ApiApplicationError &&
    error.code === "canvas_revision_conflict" &&
    error.status === 409
  );
}

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
  isStopped?: () => boolean;
}): DurableSceneMutation {
  return async (mutate) => {
    if (options.isStopped?.()) return { kind: "rejected" };
    options.cancelPendingSave();
    const previousElements = [...options.getSceneElements()];
    const nextElements = mutate(previousElements);
    options.updateScene(nextElements);
    const content = options.buildContent(nextElements);
    try {
      await options.enqueueSave(content);
      return { kind: "committed" };
    } catch (error) {
      // The server did not acknowledge this snapshot. Restore the prior live
      // scene so recovery can retry the same durable business operation.
      options.updateScene(previousElements);
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
