import { z } from 'zod';
import { encodeCursor } from './cursor';

/** Default 50, maximum 200 (ADR 0004). */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/** The documented shape of a page of `item`. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ data: z.array(item), next_cursor: z.string().nullable() });
}

/**
 * Callers fetch `limit + 1` rows ordered by id descending, starting after the
 * decoded cursor (`where: { id: { lt: cursor.id } }`). The extra row only
 * signals that another page exists; it is never returned.
 */
export function toPage<T extends { id: string }>(rows: T[], limit: number, secret: string): Page<T> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  const next_cursor = rows.length > limit && last ? encodeCursor({ id: last.id }, secret) : null;

  return { data, next_cursor };
}
