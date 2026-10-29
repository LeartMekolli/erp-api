import { z } from 'zod';

export const searchQuerySchema = z.strictObject({ q: z.string().trim().min(1).max(100) });
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** At most this many of each kind. */
export const SEARCH_LIMIT = 5;

/** What Cmd+K finds: each kind the user may not read is an empty list. */
export const searchResponseSchema = z.strictObject({
  orders: z.array(z.strictObject({ id: z.uuid(), number: z.number().int(), customer: z.strictObject({ id: z.uuid(), name: z.string() }) })).max(SEARCH_LIMIT),
  customers: z.array(z.strictObject({ id: z.uuid(), name: z.string() })).max(SEARCH_LIMIT),
  partners: z.array(z.strictObject({ id: z.uuid(), name: z.string() })).max(SEARCH_LIMIT),
  articles: z.array(z.strictObject({ id: z.uuid(), title: z.string() })).max(SEARCH_LIMIT),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
