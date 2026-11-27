import { ForbiddenException } from '@nestjs/common';
import type { TenantPermission } from './permissions';
import { TENANT_PERMISSIONS } from './permissions';
import {
  Caller,
  RoleRef,
  assertMayChangeRoles,
  assertMayGrantPermissions,
  assertMayManagePerson,
  missingPermissions,
} from './grants';

const callerHolding = (...permissions: TenantPermission[]): Caller => ({
  userId: 'caller',
  permissions: new Set(permissions),
});

const refused = (action: () => void): unknown => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as ForbiddenException).getResponse();
  }
  throw new Error('Expected a ForbiddenException');
};

describe('grants', () => {
  it('lists what is missing, sorted and unique', () => {
    expect(missingPermissions(new Set(['order.read']), ['order.read', 'payment.refund', 'payment.refund'])).toEqual([
      'payment.refund',
    ]);
  });

  describe('assertMayGrantPermissions', () => {
    it('lets a non-owner grant a permission they hold', () => {
      expect(() => assertMayGrantPermissions(callerHolding('order.read'), false, ['order.read'], [])).not.toThrow();
    });

    it('refuses a permission the non-owner lacks', () => {
      const response = refused(() => assertMayGrantPermissions(callerHolding('order.read'), false, ['payment.refund'], []));
      expect(response).toEqual({
        code: 'exceeds_own_permissions',
        permissions: ['payment.refund'],
        message: expect.any(String),
      });
    });

    it('refuses taking away a permission the non-owner lacks', () => {
      const response = refused(() => assertMayGrantPermissions(callerHolding('order.read'), false, [], ['payment.refund']));
      expect(response).toEqual({
        code: 'exceeds_own_permissions',
        permissions: ['payment.refund'],
        message: expect.any(String),
      });
    });

    it('lets an owner grant anything', () => {
      expect(() => assertMayGrantPermissions(callerHolding(), true, ['payment.refund'], ['order.read'])).not.toThrow();
    });
  });

  describe('assertMayChangeRoles', () => {
    const ownerRole: RoleRef = { name: 'owner', isSystem: true, permissions: [] };

    it('refuses the system owner role to a non-owner who holds every permission', () => {
      const response = refused(() =>
        assertMayChangeRoles(callerHolding(...TENANT_PERMISSIONS), false, [ownerRole], []),
      );
      expect(response).toEqual({ code: 'owner_only', message: expect.any(String) });
    });

    it('refuses removing the system owner role from a non-owner too', () => {
      const response = refused(() =>
        assertMayChangeRoles(callerHolding(...TENANT_PERMISSIONS), false, [], [ownerRole]),
      );
      expect(response).toEqual({ code: 'owner_only', message: expect.any(String) });
    });

    it('treats a custom role named owner as a normal role', () => {
      const custom: RoleRef = { name: 'owner', isSystem: false, permissions: ['order.read'] };
      expect(() => assertMayChangeRoles(callerHolding('order.read'), false, [custom], [])).not.toThrow();
    });

    it('refuses a role whose permissions the non-owner lacks, in added or removed', () => {
      const packing: RoleRef = { name: 'Packing', isSystem: false, permissions: ['order.read', 'payment.refund'] };
      const expected = { code: 'exceeds_own_permissions', permissions: ['payment.refund'], message: expect.any(String) };
      expect(refused(() => assertMayChangeRoles(callerHolding('order.read'), false, [packing], []))).toEqual(expected);
      expect(refused(() => assertMayChangeRoles(callerHolding('order.read'), false, [], [packing]))).toEqual(expected);
    });

    it('lets an owner change any role, including owner', () => {
      expect(() => assertMayChangeRoles(callerHolding(), true, [ownerRole], [])).not.toThrow();
    });
  });

  describe('assertMayManagePerson', () => {
    it('refuses a person who holds a permission the caller lacks', () => {
      const response = refused(() =>
        assertMayManagePerson(callerHolding('order.read'), false, { isOwner: false, permissions: ['payment.refund'] }),
      );
      expect(response).toEqual({
        code: 'person_holds_more',
        permissions: ['payment.refund'],
        message: expect.any(String),
      });
    });

    it('refuses an owner to a non-owner holding all permissions', () => {
      const response = refused(() =>
        assertMayManagePerson(callerHolding(...TENANT_PERMISSIONS), false, {
          isOwner: true,
          permissions: [...TENANT_PERMISSIONS],
        }),
      );
      expect(response).toEqual({ code: 'owner_only', message: expect.any(String) });
    });

    it('lets a non-owner manage a person who holds no more than they do', () => {
      expect(() =>
        assertMayManagePerson(callerHolding('order.read'), false, { isOwner: false, permissions: ['order.read'] }),
      ).not.toThrow();
    });

    it('lets an owner manage anyone', () => {
      expect(() =>
        assertMayManagePerson(callerHolding(), true, { isOwner: true, permissions: ['payment.refund'] }),
      ).not.toThrow();
    });
  });
});
