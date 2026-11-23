/** How long a spec may wait for UTC midnight to pass; give the `beforeAll` that waits at least this long. */
export const MIDNIGHT_GUARD_SECONDS = 90;
export const MIDNIGHT_GUARD_TIMEOUT_MS = (MIDNIGHT_GUARD_SECONDS + 30) * 1000;

/**
 * For specs that read the clock and compare against dates computed from it: waits until UTC midnight has
 * passed when the run starts within `seconds` before it, so a day or month boundary cannot fall mid-run.
 * Does nothing at any other time. Call it first in a `beforeAll` that has `MIDNIGHT_GUARD_TIMEOUT_MS`.
 */
export async function clearOfUtcMidnight(seconds = MIDNIGHT_GUARD_SECONDS): Promise<void> {
  const now = Date.now();
  const midnight = Math.ceil(now / 86_400_000) * 86_400_000;
  if (midnight - now > seconds * 1000) return;
  await new Promise((resolve) => setTimeout(resolve, midnight - now + 1000));
}
