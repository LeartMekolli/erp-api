import { createHash } from 'node:crypto';

/** Objects with sorted keys at every depth; arrays keep their order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/**
 * What a request is, for comparing a retry with the original: the same key
 * with a different fingerprint is a different request and is refused.
 */
export function fingerprint(input: { userId: string; method: string; path: string; body: unknown }): string {
  const canonical = JSON.stringify([
    input.userId,
    input.method.toUpperCase(),
    input.path,
    canonicalize(input.body ?? null),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
