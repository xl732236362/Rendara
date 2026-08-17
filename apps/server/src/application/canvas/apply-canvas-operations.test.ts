import { describe, expect, it, vi } from "vitest";

import type { StructuredLogger } from "../generation/ports.js";
import {
  type CanvasOperationPorts,
  createApplyCanvasOperations,
} from "./apply-canvas-operations.js";

const principal = {
  userId: "user-1",
  workspaceId: "workspace-1",
  accessToken: "secret-token",
};

const request = {
  canvasId: "canvas-1",
  operations: [{ action: "delete", element_id: "element-1" }],
};

function setup() {
  const calls: string[] = [];
  const ports: CanvasOperationPorts = {
    authorization: {
      requireCanvasAccess: vi.fn(async () => {
        calls.push("authorize");
      }),
    },
    operations: {
      apply: vi.fn(async () => {
        calls.push("apply");
        return { canvasId: "canvas-1", applied: 1 };
      }),
    },
  };
  const logger: StructuredLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    apply: createApplyCanvasOperations({ ports, logger }),
    calls,
    logger,
    ports,
  };
}

describe("ApplyCanvasOperations", () => {
  it("authorizes before delegating any read or mutation", async () => {
    const { apply, calls } = setup();

    await expect(apply(principal, request)).resolves.toEqual({
      canvasId: "canvas-1",
      applied: 1,
    });

    expect(calls).toEqual(["authorize", "apply"]);
  });

  it("rejects an invalid current operation without mutation", async () => {
    const { apply, ports } = setup();

    await expect(
      apply(principal, {
        canvasId: "canvas-1",
        operations: [{ action: "future_phase_node_protocol", node: {} }],
      }),
    ).rejects.toMatchObject({ code: "invalid_request", statusCode: 400 });

    expect(ports.operations.apply).not.toHaveBeenCalled();
  });

  it("normalizes service failures without exposing private messages", async () => {
    const { apply, logger, ports } = setup();
    vi.mocked(ports.operations.apply).mockRejectedValue(
      new Error("database password and canvas JSON"),
    );

    await expect(apply(principal, request)).rejects.toMatchObject({
      code: "application_error",
      statusCode: 500,
      expose: false,
      message: "Canvas operation failed.",
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      "database password",
    );
  });

  it("privately rejects an outcome for another canvas", async () => {
    const { apply, ports } = setup();
    vi.mocked(ports.operations.apply).mockResolvedValue({
      canvasId: "canvas-other",
      applied: 1,
    });

    await expect(apply(principal, request)).rejects.toMatchObject({
      code: "application_error",
      statusCode: 500,
      expose: false,
    });
  });

  it("logs identifiers and counts without credentials or operation payloads", async () => {
    const { apply, logger } = setup();

    await apply(principal, request);

    expect(logger.info).toHaveBeenCalledWith("Canvas operations applied", {
      applied: 1,
      canvasId: "canvas-1",
      operationCount: 1,
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    const logs = JSON.stringify(vi.mocked(logger.info).mock.calls);
    expect(logs).not.toContain("secret-token");
    expect(logs).not.toContain("element-1");
  });
});
