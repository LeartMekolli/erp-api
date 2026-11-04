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
