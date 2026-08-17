import { describe, expect, it, vi } from "vitest";

import { ExecutorRegistry, type JobExecutor } from "./job-executor.js";

const executor = vi.fn() as JobExecutor;

describe("ExecutorRegistry", () => {
  it("keeps registry instances isolated", () => {
    const first = new ExecutorRegistry();
    const second = new ExecutorRegistry();
    first.register("image_generation", executor);

    expect(first.get("image_generation")).toBe(executor);
    expect(second.get("image_generation")).toBeUndefined();
  });

  it("rejects duplicate job types", () => {
    const registry = new ExecutorRegistry();
    registry.register("image_generation", executor);

    expect(() => registry.register("image_generation", executor)).toThrow(
      'Duplicate executor job type: "image_generation"',
    );
  });

  it("seals mutation and lists job types deterministically", () => {
    const registry = new ExecutorRegistry();
    registry.register("video_generation", executor);
    registry.register("image_generation", executor);
    registry.seal();

    expect(registry.listJobTypes()).toEqual([
      "image_generation",
      "video_generation",
    ]);
    expect(() => registry.register("image_generation", executor)).toThrow(
      "Executor registry is sealed",
    );
  });
});
