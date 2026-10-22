import type { z } from 'zod';

/**
 * Fails when a real response differs from the shape the API docs show, and
 * prints which fields differ. Fix the documented schema, never the response.
 */
export function expectDocumented(schema: z.ZodType, body: unknown): void {
  const result = schema.safeParse(body);
  expect(result.success ? [] : result.error.issues).toEqual([]);
}
