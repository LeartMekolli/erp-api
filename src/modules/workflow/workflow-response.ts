import { z } from 'zod';

// What clients receive for workflow configuration; checked against real responses in the e2e tests.

export const defectResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** An inactive defect stays on past transitions but can't be added to a workflow step. */
  active: z.boolean(),
});
export type DefectResponse = z.infer<typeof defectResponseSchema>;
