const SECRET_KEYS =
  /^(authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|client[_-]?secret)$/i;

export function sanitizeRequestUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, "http://redaction.local");
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEYS.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "/[INVALID_URL]";
  }
}

export function sanitizeLogData(
  value: unknown,
  options: { maxDepth?: number; secretValues?: readonly string[] } = {},
): unknown {
  const secretValues = (options.secretValues ?? []).filter(Boolean);
  const ancestors = new WeakSet<object>();
  const maxDepth = options.maxDepth ?? 8;

  function sanitize(input: unknown, depth: number, key?: string): unknown {
    if (key && SECRET_KEYS.test(key)) return "[REDACTED]";
    if (depth > maxDepth) return "[TRUNCATED]";
    if (typeof input === "string") {
      let result = key?.toLowerCase().includes("url")
        ? sanitizeRequestUrl(input)
        : input;
      for (const secret of secretValues)
        result = result.split(secret).join("[REDACTED]");
      return result;
    }
    if (input === null || typeof input !== "object") return input;
    if (ancestors.has(input)) return "[CIRCULAR]";
    ancestors.add(input);
    try {
      if (Array.isArray(input))
        return input.map((item) => sanitize(item, depth + 1));
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        return `[${input.constructor?.name ?? "Object"}]`;
      }
      const output: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(input)) {
        output[childKey] = sanitize(child, depth + 1, childKey);
      }
      return output;
    } catch {
      return "[UNSERIALIZABLE]";
    } finally {
      ancestors.delete(input);
    }
  }

  return sanitize(value, 0);
}
