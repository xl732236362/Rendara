import { afterEach, describe, expect, it, vi } from "vitest";

import { CanvasEventBuffer } from "./event-buffer.js";

const event = {
  type: "message.delta" as const,
  runId: "run-1",
  messageId: "message-1",
  delta: "hello",
  timestamp: "2026-08-20T00:00:00.000Z",
};

describe("CanvasEventBuffer", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps sequence numbers above a client cursor after TTL cleanup", () => {
    vi.useFakeTimers();
    const buffer = new CanvasEventBuffer({ maxPerCanvas: 2, ttlMs: 10 });

    buffer.push("canvas-1", event);
    vi.advanceTimersByTime(11);
    buffer.cleanup();
    const next = buffer.push("canvas-1", event);

    expect(next).toBe(2);
  });

  it("reports when a requested cursor is older than the retained window", () => {
    const buffer = new CanvasEventBuffer({ maxPerCanvas: 2 });
    buffer.push("canvas-1", event);
    buffer.push("canvas-1", event);
    buffer.push("canvas-1", event);
    buffer.push("canvas-1", event);

    expect(buffer.getAfterWithStatus("canvas-1", 0)).toMatchObject({
      gap: false,
      earliestSeq: 3,
      latestSeq: 4,
    });
    expect(buffer.getAfterWithStatus("canvas-1", 1)).toMatchObject({
      gap: true,
      events: [],
      earliestSeq: 3,
      latestSeq: 4,
    });
  });

  it("reports a gap when TTL cleanup removed the retained window", () => {
    vi.useFakeTimers();
    const buffer = new CanvasEventBuffer({ ttlMs: 10 });
    buffer.push("canvas-1", event);
    buffer.push("canvas-1", event);
    vi.advanceTimersByTime(11);
    buffer.cleanup();

    expect(buffer.getAfterWithStatus("canvas-1", 0)).toMatchObject({
      gap: false,
      earliestSeq: null,
      latestSeq: 2,
    });
    expect(buffer.getAfterWithStatus("canvas-1", 1)).toMatchObject({
      gap: true,
      events: [],
      latestSeq: 2,
    });
  });
});
