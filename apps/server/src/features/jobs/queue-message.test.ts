import { describe, expect, it } from "vitest";

import {
  createGenerationQueueMessage,
  parseGenerationQueueMessage,
} from "./queue-message.js";

describe("generation queue boundary", () => {
  it("round-trips the producer message into worker dispatch input", () => {
    const message = createGenerationQueueMessage({
      jobId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "550e8400-e29b-41d4-a716-446655440001",
      canvasId: "550e8400-e29b-41d4-a716-446655440002",
      sessionId: "550e8400-e29b-41d4-a716-446655440003",
      threadId: "thread-123",
      jobType: "image_generation",
      payload: {
        job_id: "550e8400-e29b-41d4-a716-446655440099",
        prompt: "A product photograph",
        title: "Campaign visual",
        aspect_ratio: "1:1",
        input_images: ["https://example.com/reference.png"],
      },
    });

    expect(parseGenerationQueueMessage(message)).toEqual({
      success: true,
      data: {
        jobId: "550e8400-e29b-41d4-a716-446655440000",
        jobType: "image_generation",
        payload: message.payload,
      },
    });
  });

  it.each([
    { job_id: "legacy", job_type: "image_generation" },
    {
      schemaVersion: 1,
      type: "image_generation",
      payload: {
        job_id: "550e8400-e29b-41d4-a716-446655440000",
        workspace_id: "550e8400-e29b-41d4-a716-446655440001",
        prompt: "Wrong media fields",
        duration: 5,
      },
    },
  ])("rejects malformed or legacy message %#", (message) => {
    expect(parseGenerationQueueMessage(message)).toMatchObject({
      success: false,
      code: "invalid_queue_message",
    });
  });
});
