import { describe, expect, it } from "vitest";

import { ConnectionManager } from "./connection-manager.js";

describe("ConnectionManager identity", () => {
  it("does not let another user replace an existing connection id", () => {
    const manager = new ConnectionManager();
    const originalSocket = { readyState: 1 } as never;
    const attackingSocket = { readyState: 1 } as never;

    expect(manager.register("connection-1", "user-1", originalSocket)).toBe(
      true,
    );
    expect(manager.register("connection-1", "user-2", attackingSocket)).toBe(
      false,
    );
    expect(manager.getEntry("connection-1")).toMatchObject({
      userId: "user-1",
      ws: originalSocket,
    });
  });

  it("routes canvas RPCs only to the user's connection bound to that canvas", async () => {
    const manager = new ConnectionManager();
    const sent: Array<{ connectionId: string; payload: string }> = [];
    const socket = (connectionId: string) =>
      ({
        readyState: 1,
        send: (payload: string) => sent.push({ connectionId, payload }),
      }) as never;
    manager.register("connection-a", "user-1", socket("connection-a"));
    manager.register("connection-b", "user-1", socket("connection-b"));
    manager.bindCanvas("connection-a", "canvas-a");
    manager.bindCanvas("connection-b", "canvas-b");

    const pending = manager.rpcToCanvas(
      "user-1",
      "canvas-b",
      "canvas.screenshot",
      {},
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.connectionId).toBe("connection-b");
    const request = JSON.parse(sent[0]?.payload ?? "{}") as { id: string };
    manager.handleRpcResponse("connection-b", {
      type: "rpc.response",
      id: request.id,
      result: { ok: true },
    });
    await expect(pending).resolves.toEqual({ ok: true });
  });
});
