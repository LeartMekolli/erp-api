/**
 * Permissions are code; roles are data (F4, D57). Each domain module adds its
 * own keys here: read, write, and named sensitive actions.
 */
export const TENANT_PERMISSIONS = [
  'settings.read',
  'settings.write',
  'user.read',
  'user.invite',
  'user.deactivate',
  'role.read',
  'role.write',
  'role.assign',
  'template.read',
  'template.write',
  'file.read',
  'file.write',
  'catalog.read',
  'catalog.write',
  // Sensitive (F4): replaces a material's price by hand, audited.
  'material.price.override',
] as const;

/** Held only by platform admins, through platform-scoped tokens (ADR 0001). */
export const PLATFORM_PERMISSIONS = [
  'platform.tenant.read',
  'platform.tenant.create',
  'platform.tenant.suspend',
  'platform.jobs.read',
  'platform.jobs.retry',
  'platform.diagnostics',
] as const;

export type TenantPermission = (typeof TENANT_PERMISSIONS)[number];
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export type Permission = TenantPermission | PlatformPermission;

/**
 * Created with every tenant and never editable (plan 2, P7). Everything else
 * is a custom role the tenant defines.
 */
export const SYSTEM_ROLES = {
  owner: TENANT_PERMISSIONS,
  member: ['settings.read', 'user.read', 'role.read', 'template.read', 'file.read', 'catalog.read'],
} as const satisfies Record<string, readonly TenantPermission[]>;

export type SystemRoleName = keyof typeof SYSTEM_ROLES;

const tenantPermissions: ReadonlySet<string> = new Set(TENANT_PERMISSIONS);

export function isTenantPermission(value: string): value is TenantPermission {
  return tenantPermissions.has(value);
}
