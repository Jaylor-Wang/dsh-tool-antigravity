/** Shared bounded text predicate for Host trust-boundary values. */
export function isBoundedSafeText(value: unknown, maxLength: number, minLength = 1): value is string {
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(maxLength) ||
    !Number.isSafeInteger(minLength) ||
    minLength < 0 ||
    maxLength < minLength ||
    value.length < minLength ||
    value.length > maxLength
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint < 32 || codePoint === 127) return false;
  }
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
