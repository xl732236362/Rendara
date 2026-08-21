import { QueryClient } from "@tanstack/react-query";

const MAX_QUERY_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;

function hasRetryableServerStatus(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return false;
  }
  const status = error.status;
  return typeof status === "number" && status >= 500 && status < 600;
}

function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "NetworkError")
  );
}

function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return (
    failureCount < MAX_QUERY_RETRIES &&
    (isNetworkFailure(error) || hasRetryableServerStatus(error))
  );
}

function retryDelay(attemptIndex: number): number {
  const exponentialDelay = Math.min(
    INITIAL_RETRY_DELAY_MS * 2 ** attemptIndex,
    MAX_RETRY_DELAY_MS,
  );
  // Equal jitter avoids synchronized retries while retaining exponential growth.
  return Math.min(
    exponentialDelay / 2 + Math.random() * (exponentialDelay / 2),
    MAX_RETRY_DELAY_MS,
  );
}

export function createLoomicQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        retryDelay,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
