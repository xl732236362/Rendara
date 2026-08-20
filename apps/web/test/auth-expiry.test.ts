import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthExpiryHandler,
  notifyApiAuthExpired,
  registerApiAuthExpiryHandler,
} from "../src/lib/auth-expiry";

describe("REST auth expiry boundary", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clears the session and navigates once for consecutive 401s", async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    const navigateToLogin = vi.fn();
    const handler = createAuthExpiryHandler({
      signOut,
      navigateToLogin,
      getReturnTo: () => "/canvas?id=canvas-1#selection",
      logger: { warn: vi.fn() },
    });
    const unregister = registerApiAuthExpiryHandler(handler);

    notifyApiAuthExpired();
    notifyApiAuthExpired();
    await vi.waitFor(() => expect(navigateToLogin).toHaveBeenCalledOnce());

    expect(signOut).toHaveBeenCalledOnce();
    expect(navigateToLogin).toHaveBeenCalledWith(
      "/login?error=session_expired&returnTo=%2Fcanvas%3Fid%3Dcanvas-1%23selection",
    );
    unregister();
  });

  it("falls back to a safe local return path", async () => {
    const navigateToLogin = vi.fn();
    const handler = createAuthExpiryHandler({
      signOut: vi.fn().mockResolvedValue(undefined),
      navigateToLogin,
      getReturnTo: () => "//external.example/steal",
      logger: { warn: vi.fn() },
    });

    handler();
    await vi.waitFor(() => expect(navigateToLogin).toHaveBeenCalledOnce());
    expect(navigateToLogin).toHaveBeenCalledWith(
      "/login?error=session_expired&returnTo=%2F",
    );
  });
});
