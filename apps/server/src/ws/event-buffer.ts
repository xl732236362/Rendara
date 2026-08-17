import type { StreamEvent } from "@loomic/shared";

type BufferedEvent = {
  event: StreamEvent;
  timestamp: number;
  seq: number;
};

/**
 * Per-canvas ring buffer for recent StreamEvents.
 * Enables event replay on client reconnection.
 */
export class CanvasEventBuffer {
  private buffers = new Map<string, BufferedEvent[]>();
  private seqCounters = new Map<string, number>();
  private readonly maxPerCanvas: number;
  private readonly ttlMs: number;
  private lastWrite = new Map<string, number>();
  private domainEventIds = new Map<string, Set<string>>();

  constructor(options?: { maxPerCanvas?: number; ttlMs?: number }) {
    this.maxPerCanvas = options?.maxPerCanvas ?? 5000;
    this.ttlMs = options?.ttlMs ?? 10 * 60 * 1000;
  }

  push(canvasId: string, event: StreamEvent): void {
    let buf = this.buffers.get(canvasId);
    if (!buf) {
      buf = [];
      this.buffers.set(canvasId, buf);
      this.seqCounters.set(canvasId, 0);
    }

    const seq = (this.seqCounters.get(canvasId) ?? 0) + 1;
    this.seqCounters.set(canvasId, seq);
    buf.push({ event, timestamp: Date.now(), seq });

    if (buf.length > this.maxPerCanvas) {
      buf.splice(0, buf.length - this.maxPerCanvas);
    }

    this.lastWrite.set(canvasId, Date.now());
  }

  pushDomainEvent(
    canvasId: string,
    eventId: string,
    event: StreamEvent,
  ): boolean {
    const seen = this.domainEventIds.get(canvasId) ?? new Set<string>();
    if (seen.has(eventId)) return false;
    seen.add(eventId);
    this.domainEventIds.set(canvasId, seen);
    this.push(canvasId, event);
    return true;
  }

  getAfter(canvasId: string, afterSeq?: number): BufferedEvent[] {
    const buf = this.buffers.get(canvasId);
    if (!buf || buf.length === 0) return [];
    if (!afterSeq) return [...buf];
    return buf.filter((e) => e.seq > afterSeq);
  }

  getLatestSeq(canvasId: string): number {
    return this.seqCounters.get(canvasId) ?? 0;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [canvasId, lastTime] of this.lastWrite) {
      if (now - lastTime > this.ttlMs) {
        this.buffers.delete(canvasId);
        this.seqCounters.delete(canvasId);
        this.lastWrite.delete(canvasId);
        this.domainEventIds.delete(canvasId);
      }
    }
  }

  dispose(): void {
    this.buffers.clear();
    this.seqCounters.clear();
    this.lastWrite.clear();
    this.domainEventIds.clear();
  }
}
