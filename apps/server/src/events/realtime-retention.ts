const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const KEEP_PER_CANVAS = 5_000;

export function createRealtimeRetentionCleanup(options: {
  prune(input: { before: Date; keepPerCanvas: number }): Promise<number>;
  now?: () => Date;
  onError?(error: unknown): void;
  onPruned?(deleted: number): void;
}) {
  let timer: NodeJS.Timeout | undefined;
  const runOnce = async () => {
    const now = options.now?.() ?? new Date();
    const deleted = await options.prune({
      before: new Date(now.getTime() - RETENTION_MS),
      keepPerCanvas: KEEP_PER_CANVAS,
    });
    options.onPruned?.(deleted);
    return deleted;
  };
  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(
        () => void runOnce().catch((error) => options.onError?.(error)),
        CLEANUP_INTERVAL_MS,
      );
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
