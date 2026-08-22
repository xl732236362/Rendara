type QueryFilters = Readonly<Record<string, unknown>>;

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return [...new Set(value.map(normalizeValue))].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }
  if (value && typeof value === "object")
    return normalizeFilters(value as QueryFilters);
  return value;
}

function normalizeFilters(filters: QueryFilters): QueryFilters {
  return Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, normalizeValue(value)]),
  );
}

const workspaceRoot = (userId: string, workspaceId: string) =>
  ["users", userId, "workspaces", workspaceId] as const;

export const queryKeys = {
  disabled: (resource: string) => ["disabled", resource] as const,
  viewer: (userId: string) => ["users", userId, "viewer"] as const,
  public: {
    models: {
      agent: ["public", "models", "agent"] as const,
      image: (filters: QueryFilters = {}) =>
        ["public", "models", "image", normalizeFilters(filters)] as const,
      video: (filters: QueryFilters = {}) =>
        ["public", "models", "video", normalizeFilters(filters)] as const,
    },
  },
  workspace: {
    canvas: (userId: string, workspaceId: string, canvasId: string) =>
      [...workspaceRoot(userId, workspaceId), "canvases", canvasId] as const,
    projects: (
      userId: string,
      workspaceId: string,
      filters: QueryFilters = {},
    ) =>
      [
        ...workspaceRoot(userId, workspaceId),
        "projects",
        normalizeFilters(filters),
      ] as const,
    brandKits: (
      userId: string,
      workspaceId: string,
      filters: QueryFilters = {},
    ) =>
      [
        ...workspaceRoot(userId, workspaceId),
        "brand-kits",
        normalizeFilters(filters),
      ] as const,
    creditTransactions: (
      userId: string,
      workspaceId: string,
      filters: QueryFilters = {},
    ) =>
      [
        ...workspaceRoot(userId, workspaceId),
        "credits",
        "transactions",
        normalizeFilters(filters),
      ] as const,
    chatSessions: (
      userId: string,
      workspaceId: string,
      canvasId: string,
      filters: QueryFilters = {},
    ) =>
      [
        ...workspaceRoot(userId, workspaceId),
        "canvases",
        canvasId,
        "sessions",
        normalizeFilters(filters),
      ] as const,
    chatMessages: (
      userId: string,
      workspaceId: string,
      canvasId: string,
      sessionId: string,
      filters: QueryFilters = {},
    ) =>
      [
        ...workspaceRoot(userId, workspaceId),
        "canvases",
        canvasId,
        "sessions",
        sessionId,
        "messages",
        normalizeFilters(filters),
      ] as const,
    models: {
      image: (
        userId: string,
        workspaceId: string,
        filters: QueryFilters = {},
      ) =>
        [
          ...workspaceRoot(userId, workspaceId),
          "models",
          "image",
          normalizeFilters(filters),
        ] as const,
      video: (
        userId: string,
        workspaceId: string,
        filters: QueryFilters = {},
      ) =>
        [
          ...workspaceRoot(userId, workspaceId),
          "models",
          "video",
          normalizeFilters(filters),
        ] as const,
    },
  },
} as const;
