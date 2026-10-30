import { z } from 'zod';

export const brandProfileBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  sells: z.string().trim().min(1).max(500),
  audience: z.string().trim().min(1).max(500),
  tone: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(1000).default(''),
});
export type BrandProfileBody = z.infer<typeof brandProfileBodySchema>;

/** A customer's brand profile: what its AI tools read about it. */
export const brandProfileSchema = z.strictObject({
  name: z.string(),
  sells: z.string(),
  audience: z.string(),
  tone: z.string(),
  notes: z.string(),
  updated_at: z.string(),
});
export type BrandProfileResponse = z.infer<typeof brandProfileSchema>;
