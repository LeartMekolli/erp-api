import { z } from 'zod';

/** A skill in the workspace's catalogue (Workflow 2 spec, goal 9). */
export const skillResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  archived: z.boolean(),
  created_at: z.string(),
});
export type SkillResponse = z.infer<typeof skillResponseSchema>;

export const skillListResponseSchema = z.strictObject({ data: z.array(skillResponseSchema) });

/** A skill a staff member holds (goal 10): `expired` once `expires_on` is past in the workspace's zone. */
export const userSkillResponseSchema = z.strictObject({
  skill: z.strictObject({ id: z.uuid(), name: z.string() }),
  expires_on: z.iso.date().nullable(),
  expired: z.boolean(),
});
export type UserSkillResponse = z.infer<typeof userSkillResponseSchema>;

export const userSkillListResponseSchema = z.strictObject({ data: z.array(userSkillResponseSchema) });

export function toSkillResponse(skill: { id: string; name: string; archivedAt: Date | null; createdAt: Date }): SkillResponse {
  return {
    id: skill.id,
    name: skill.name,
    archived: skill.archivedAt !== null,
    created_at: skill.createdAt.toISOString(),
  };
}
