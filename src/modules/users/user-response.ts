import { z } from 'zod';

/** Every user is one kind (`User.kind`): customer and partner people hold memberships, never workspace roles. */
export const USER_KINDS = ['staff', 'partner', 'customer'] as const;
export type UserKind = (typeof USER_KINDS)[number];

/**
 * The only shape a user leaves the API in: an allow-list, so a column added
 * later (a hash, a secret) stays out of responses unless someone adds it here
 * (spec 4.8).
 */
export const userResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  status: z.string(),
  locale: z.string(),
  created_at: z.string(),
});
export type UserResponse = z.infer<typeof userResponseSchema>;

/** A skill a person holds. `expired` is judged on the workspace's calendar date; `archived` skills stay on the row. */
export const heldSkillSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  expires_on: z.iso.date().nullable(),
  expired: z.boolean(),
  archived: z.boolean(),
});
export type HeldSkillResponse = z.infer<typeof heldSkillSchema>;

/** A person as the staff list shows them: the user plus their roles and skills. */
export const staffUserResponseSchema = userResponseSchema.extend({
  roles: z.array(z.strictObject({ id: z.uuid(), name: z.string(), is_system: z.boolean() })),
  skills: z.array(heldSkillSchema),
});
export type StaffUserResponse = z.infer<typeof staffUserResponseSchema>;

export const staffUserListResponseSchema = z.strictObject({
  data: z.array(staffUserResponseSchema),
  next_cursor: z.string().nullable(),
});

export function toStaffUserResponse(
  user: Parameters<typeof toUserResponse>[0],
  roles: StaffUserResponse['roles'],
  skills: HeldSkillResponse[],
): StaffUserResponse {
  return { ...toUserResponse(user), roles, skills };
}

export function toUserResponse(user: {
  id: string;
  email: string;
  name: string;
  status: string;
  locale: string;
  createdAt: Date;
}): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    locale: user.locale,
    created_at: user.createdAt.toISOString(),
  };
}
