import {
  PLATFORM_PERMISSIONS,
  SYSTEM_ROLES,
  TENANT_PERMISSIONS,
  isTenantPermission,
} from './permissions';

describe('permissions', () => {
  it('gives the owner every tenant permission', () => {
    expect([...SYSTEM_ROLES.owner].sort()).toEqual([...TENANT_PERMISSIONS].sort());
  });

  it('keeps the member to reading, plus requesting quotes', () => {
    expect([...SYSTEM_ROLES.member].sort()).toEqual([
      'catalog.read',
      'file.read',
      'quote.create',
      'role.read',
      'settings.read',
      'template.read',
      'user.read',
    ]);
  });

  it('keeps tenant and platform permissions apart', () => {
    expect(TENANT_PERMISSIONS.some((permission) => permission.startsWith('platform.'))).toBe(false);
    expect(PLATFORM_PERMISSIONS.every((permission) => permission.startsWith('platform.'))).toBe(true);
  });

  it('recognises tenant permissions only', () => {
    expect(isTenantPermission('settings.write')).toBe(true);
    expect(isTenantPermission('platform.tenant.create')).toBe(false);
    expect(isTenantPermission('made.up')).toBe(false);
  });
});
