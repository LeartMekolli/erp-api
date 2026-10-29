import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import { SUGGESTION_KINDS } from './suggestions';
import { RECORD_TYPES, recordRefSchema } from './tools/tool';

export const askSchema = z.strictObject({ question: z.string().trim().min(1).max(500) });
export type AskBody = z.infer<typeof askSchema>;

export const askResponseSchema = z.strictObject({ id: z.uuid() });

const labelledRefSchema = z.strictObject({ type: z.enum(RECORD_TYPES), id: z.uuid(), label: z.string() });

/** One run, for the user who asked. Labels are read now; a record the reader may no longer see is left out. */
export const aiRunResponseSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['ask', 'briefing']),
  status: z.enum(['pending', 'done', 'failed']),
  answer: z
    .strictObject({
      text: z.string(),
      refs: z.array(labelledRefSchema),
      action: z.strictObject({ kind: z.enum(SUGGESTION_KINDS), targets: z.array(labelledRefSchema) }).nullable(),
    })
    .nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type AiRunResponse = z.infer<typeof aiRunResponseSchema>;

export const aiRunListQuerySchema = paginationQuerySchema;

/** The workspace's run log: what each run cost, never what it said. */
export const aiRunListItemSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['ask', 'briefing']),
  user: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  model: z.string(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  // USD, to the millionth of a dollar.
  cost_usd: z.string().nullable(),
  status: z.enum(['pending', 'done', 'failed']),
  created_at: z.string(),
});
export const aiRunListResponseSchema = pageSchema(aiRunListItemSchema);
export type AiRunListItem = z.infer<typeof aiRunListItemSchema>;

/** What the `ask` job stores in `ai_run.output`. */
export const storedAnswerSchema = z.strictObject({
  text: z.string(),
  refs: z.array(recordRefSchema),
  action: z.strictObject({ kind: z.enum(SUGGESTION_KINDS), targets: z.array(recordRefSchema) }).nullable(),
});
