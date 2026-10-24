/** Roles inside a partner company, lowest first; each may do what any lower one may (Partners spec, goal 1). */
export const PARTNER_ROLES = ['member', 'admin', 'owner'] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];

/** Whether `role` may do what `required` may. */
export function atLeast(role: PartnerRole, required: PartnerRole): boolean {
  return PARTNER_ROLES.indexOf(role) >= PARTNER_ROLES.indexOf(required);
}
