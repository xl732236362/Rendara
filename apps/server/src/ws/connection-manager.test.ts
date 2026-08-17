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
});
