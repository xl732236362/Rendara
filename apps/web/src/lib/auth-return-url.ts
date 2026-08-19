export function safeAuthReturnUrl(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/home";
  }

  try {
    const parsed = new URL(value, "http://loomic.local");
    return parsed.origin === "http://loomic.local"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/home";
  } catch {
    return "/home";
  }
}
