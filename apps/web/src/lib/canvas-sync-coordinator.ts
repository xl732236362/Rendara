type CanvasSyncRequest = {
  readonly eventId: string;
  readonly revision: number;
};

type CanvasSyncCoordinatorOptions = {
  readonly appliedRevision: number;
  readonly fetchAndApply: (targetRevision: number) => Promise<number>;
  readonly maxRecentEventIds?: number;
};

export function createCanvasSyncCoordinator(
  options: CanvasSyncCoordinatorOptions,
) {
  const maxRecentEventIds = options.maxRecentEventIds ?? 256;
  const recentEventIds = new Set<string>();
  let appliedRevision = options.appliedRevision;
  let targetRevision = appliedRevision;
  let activeSync: Promise<void> | null = null;
  let activeEventIds = new Set<string>();

  async function synchronize() {
    while (targetRevision > appliedRevision) {
      const requestedRevision = targetRevision;
      const visibleRevision = await options.fetchAndApply(requestedRevision);
      if (visibleRevision < requestedRevision) {
        throw new Error("canvas_sync_revision_not_visible");
      }
      appliedRevision = Math.max(appliedRevision, visibleRevision);
    }
  }

  return {
    appliedRevision: () => appliedRevision,
    request(request: CanvasSyncRequest) {
      if (
        recentEventIds.has(request.eventId) ||
        request.revision <= appliedRevision
      ) {
        return activeSync ?? Promise.resolve();
      }
      recentEventIds.add(request.eventId);
      activeEventIds.add(request.eventId);
      if (recentEventIds.size > maxRecentEventIds) {
        const oldest = recentEventIds.values().next().value;
        if (oldest) recentEventIds.delete(oldest);
      }
      targetRevision = Math.max(targetRevision, request.revision);
      if (!activeSync) {
        activeSync = synchronize()
          .catch((error: unknown) => {
            for (const eventId of activeEventIds)
              recentEventIds.delete(eventId);
            throw error;
          })
          .finally(() => {
            activeEventIds = new Set<string>();
            activeSync = null;
          });
      }
      return activeSync;
    },
  };
}
