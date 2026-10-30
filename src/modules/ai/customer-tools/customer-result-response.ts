import { z } from 'zod';
import { CUSTOMER_TOOLS } from './customer-tools';
import type { CustomerTool } from './customer-tools';

/** Catalog text written from the brand profile, as the `brand_content` final tool returns it. */
export const brandContentOutputSchema = z.strictObject({
  names: z.array(z.string().max(80)).min(1).max(3),
  short: z.string().max(300),
  long: z.string().max(2000),
  tags: z.array(z.string().max(30)).max(10),
});

const base = {
  id: z.uuid(),
  status: z.enum(['pending', 'done', 'failed']),
  /** What the customer asked with. */
  input: z.record(z.string(), z.unknown()),
  credits: z.number().int(),
  credits_given_back: z.boolean(),
  error: z.string().nullable(),
  /** The image a refinement was made from. */
  parent_id: z.uuid().nullable(),
  /** The image an image run made, a file of the customer's. */
  file_id: z.uuid().nullable(),
  asked_by: z.strictObject({ id: z.uuid(), name: z.string() }),
  created_at: z.string(),
  finished_at: z.string().nullable(),
};

function member<T extends CustomerTool, S extends z.ZodType>(tool: T, output: S) {
  return z.strictObject({ ...base, tool: z.literal(tool), output: output.nullable() });
}

/** Each tool's stored output, by tool; a tool's output is checked by its final tool before it is stored. */
export const TOOL_OUTPUTS = {
  brand_content: brandContentOutputSchema,
} as const;

/** One use of a customer AI tool, for the customer's people: the run's status and, once done, its output. */
export const customerResultSchema = z.discriminatedUnion('tool', [member('brand_content', TOOL_OUTPUTS.brand_content)]);
export type CustomerResultResponse = z.infer<typeof customerResultSchema>;

export const customerResultListQuerySchema = z.object({
  tool: z.enum(CUSTOMER_TOOLS).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.string().optional(),
});
export type CustomerResultListQuery = z.infer<typeof customerResultListQuerySchema>;
