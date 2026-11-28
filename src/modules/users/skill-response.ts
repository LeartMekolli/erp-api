import { z } from 'zod';

/** A skill in the workspace's catalogue (Workflow 2 spec, goal 9). */
export const skillResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  archived: z.boolean(),
  created_at: z.string(),
  /** Active staff holding it whose last day isn't past, in the workspace's zone. */
  holders_count: z.number().int(),
  /** Of those, the ones whose last day is today to today + 30, inclusive. */
  expiring_soon_count: z.number().int(),
  /** Active staff holding it whose last day is before the workspace's today. */
  expired_count: z.number().int(),
  /** Steps of each workflow's current version that require it. */
  required_by: z.array(
    z.strictObject({
      workflow: z.strictObject({ id: z.uuid(), name: z.string() }),
      step: z.strictObject({ id: z.uuid(), name: z.string() }),
    }),
  ),
});
export type SkillResponse = z.infer<typeof skillResponseSchema>;

export const skillListResponseSchema = z.strictObject({ data: z.array(skillResponseSchema) });

/** A skill a staff member holds (goal 10): `expired` once `expires_on` is past in the workspace's zone. */
export const userSkillResponseSchema = z.strictObject({
  skill: z.strictObject({ id: z.uuid(), name: z.string() }),
  expires_on: z.iso.date().nullable(),
  expired: z.boolean(),
  archived: z.boolean(),
});
export type UserSkillResponse = z.infer<typeof userSkillResponseSchema>;

export const userSkillListResponseSchema = z.strictObject({ data: z.array(userSkillResponseSchema) });

export type SkillUsage = Pick<SkillResponse, 'holders_count' | 'expiring_soon_count' | 'expired_count' | 'required_by'>;

export function toSkillResponse(
  skill: { id: string; name: string; archivedAt: Date | null; createdAt: Date },
  usage: SkillUsage,
): SkillResponse {
  return {
    ...usage,
    id: skill.id,
    name: skill.name,
    archived: skill.archivedAt !== null,
    created_at: skill.createdAt.toISOString(),
  };
}
