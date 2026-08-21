import { describe, expect, it } from "vitest";
import { parseRealtimeNotification } from "./postgres-realtime-listener.js";

describe("Postgres realtime notification parsing", () => {
  it("accepts only bounded realtime canvas hints", () => {
    expect(
      parseRealtimeNotification({
        channel: "loomic_realtime_canvas",
        payload: JSON.stringify({
          canvasId: "10000000-0000-4000-8000-000000000001",
          eventId: "10000000-0000-4000-8000-000000000002",
          seq: 3,
        }),
      }),
    ).toEqual({
      canvasId: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000002",
      seq: 3,
    });
    expect(
      parseRealtimeNotification({
        channel: "other",
        payload: "{}",
      }),
    ).toBeNull();
    expect(
      parseRealtimeNotification({
        channel: "loomic_realtime_canvas",
        payload: "not-json",
      }),
    ).toBeNull();
  });
});
