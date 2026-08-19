type AuthExpiryHandler = () => void;

type AuthExpiryLogger = {
  warn(message: string, fields: Record<string, unknown>): void;
};

let activeHandler: AuthExpiryHandler | null = null;

export function registerApiAuthExpiryHandler(handler: AuthExpiryHandler) {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

export function notifyApiAuthExpired(): void {
  try {
    activeHandler?.();
  } catch {
    console.warn("[auth] session expiry handler failed");
  }
}

export function createAuthExpiryHandler(options: {
  signOut(): Promise<void>;
  navigateToLogin(path: string): void;
  getReturnTo(): string;
  logger?: AuthExpiryLogger;
}): AuthExpiryHandler {
  let handled = false;

  return () => {
    if (handled) return;
    handled = true;

    const returnTo = safeReturnTo(options.getReturnTo());
    options.logger?.warn("[auth] session expired; redirecting to login", {
      returnTo,
    });
    void Promise.resolve()
      .then(() => options.signOut())
      .catch(() => undefined)
      .then(() => {
        options.navigateToLogin(
          `/login?${new URLSearchParams({
            error: "session_expired",
            returnTo,
          }).toString()}`,
        );
      });
  };
}

function safeReturnTo(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
