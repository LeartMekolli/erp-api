import { z } from 'zod';
import { CUSTOMER_TOOLS } from './customer-tools';
import type { CustomerTool } from './customer-tools';

/** What starting a tool answers: the run to poll at `GET …/ai/runs/{id}`. */
export const startedSchema = z.strictObject({ id: z.uuid() });

export const brandContentBodySchema = z
  .strictObject({
    product_id: z.uuid().optional(),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .refine((body) => (body.product_id === undefined) !== (body.description === undefined), {
    message: 'Give either product_id or description',
  });
export type BrandContentBody = z.infer<typeof brandContentBodySchema>;

/** Catalog text written from the brand profile, as the `brand_content` final tool returns it. */
export const brandContentOutputSchema = z.strictObject({
  names: z.array(z.string().max(80)).min(1).max(3),
  short: z.string().max(300),
  long: z.string().max(2000),
  tags: z.array(z.string().max(30)).max(10),
});
export type BrandContentOutput = z.infer<typeof brandContentOutputSchema>;

/** One of the customer's own numbers, as the model reads it and the customer sees it on a card. */
export const figureSchema = z.strictObject({ key: z.string(), label: z.string(), value: z.string() });
export type Figure = z.infer<typeof figureSchema>;

/** What a marketing run stores: each card with the figures it cites, in full. */
export const marketingOutputSchema = z.strictObject({
  cards: z
    .array(z.strictObject({ title: z.string(), advice: z.string(), figures: z.array(figureSchema).min(1) }))
    .min(1)
    .max(4),
});

export const recommendationsBodySchema = z.strictObject({
  focus: z.string().trim().min(1).max(200).optional(),
});
export type RecommendationsBody = z.infer<typeof recommendationsBodySchema>;

/** Links to pages the run's web searches found, nothing else. */
const sourcesSchema = z.array(z.url()).max(3);

/** Product ideas and general advice, as the `recommendations` final tool returns them and the run stores them. */
export const recommendationsOutputSchema = z.strictObject({
  ideas: z
    .array(z.strictObject({ title: z.string().max(80), why: z.string().max(600), sources: sourcesSchema }))
    .min(1)
    .max(5),
  advice: z.array(z.strictObject({ text: z.string().max(600), sources: sourcesSchema })).max(3),
});
export type RecommendationsOutput = z.infer<typeof recommendationsOutputSchema>;

export const imagesBodySchema = z.strictObject({
  description: z.string().trim().min(1).max(1000),
  /** An image of this customer's history to change; absent: a new image. */
  from_id: z.uuid().optional(),
});
export type ImagesBody = z.infer<typeof imagesBodySchema>;

/** What an image run stores: the prompt Claude wrote (before the 3D rules), and the image's file. */
export const imageOutputSchema = z.strictObject({ prompt: z.string(), file_id: z.uuid() });

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
  marketing: marketingOutputSchema,
  recommendations: recommendationsOutputSchema,
  image: imageOutputSchema,
} as const;

/** One use of a customer AI tool, for the customer's people: the run's status and, once done, its output. */
export const customerResultSchema = z.discriminatedUnion('tool', [
  member('brand_content', TOOL_OUTPUTS.brand_content),
  member('marketing', TOOL_OUTPUTS.marketing),
  member('recommendations', TOOL_OUTPUTS.recommendations),
  member('image', TOOL_OUTPUTS.image),
]);
export type CustomerResultResponse = z.infer<typeof customerResultSchema>;

export const customerResultListQuerySchema = z.object({
  tool: z.enum(CUSTOMER_TOOLS).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.string().optional(),
});
export type CustomerResultListQuery = z.infer<typeof customerResultListQuerySchema>;
