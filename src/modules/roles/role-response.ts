import { z } from 'zod';

/** A role as the settings show it. `members_count` counts active people; `invitations_count` waiting invitations. */
export const roleResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  is_system: z.boolean(),
  permissions: z.array(z.string()),
  members_count: z.number().int(),
  invitations_count: z.number().int(),
});
export type RoleResponse = z.infer<typeof roleResponseSchema>;

export const roleListResponseSchema = z.strictObject({ data: z.array(roleResponseSchema) });

export interface RoleRow {
  id: string;
  name: string;
  isSystem: boolean;
  permissions: { permission: string }[];
}

export function toRoleResponse(role: RoleRow, counts: { members: number; invitations: number }): RoleResponse {
  return {
    id: role.id,
    name: role.name,
    is_system: role.isSystem,
    permissions: role.permissions.map((row) => row.permission).sort(),
    members_count: counts.members,
    invitations_count: counts.invitations,
  };
}
