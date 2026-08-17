export function safeRead(value: unknown, key: PropertyKey): unknown {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

export function safeReadString(
  value: unknown,
  key: PropertyKey,
): string | undefined {
  const property = safeRead(value, key);
  return typeof property === "string" ? property : undefined;
}

export function safeInstanceOf(
  value: unknown,
  classConstructor: abstract new (...args: never[]) => unknown,
): boolean {
  try {
    return value instanceof classConstructor;
  } catch {
    return false;
  }
}

export function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "Unknown thrown value";
  }
}
