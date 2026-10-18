/**
 * Polls until `probe` returns a value other than `undefined`, for assertions on
 * work that finishes in another process or on another tick (jobs, email).
 */
export async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
