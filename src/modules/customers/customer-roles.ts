/** Roles inside a customer organisation (Q9), lowest first; each may do what any lower one may. */
export const CUSTOMER_ROLES = ['viewer', 'buyer', 'admin', 'owner'] as const;
export type CustomerRole = (typeof CUSTOMER_ROLES)[number];

/** Whether `role` may do what `required` may. */
export function atLeast(role: CustomerRole, required: CustomerRole): boolean {
  return CUSTOMER_ROLES.indexOf(role) >= CUSTOMER_ROLES.indexOf(required);
}
