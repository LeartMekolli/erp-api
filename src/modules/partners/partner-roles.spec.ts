import { PARTNER_ROLES, atLeast } from './partner-roles';

describe('partner roles', () => {
  it('ranks member, admin, owner from lowest to highest', () => {
    expect(PARTNER_ROLES).toEqual(['member', 'admin', 'owner']);
  });

  it('lets a role do what any lower role may', () => {
    expect(atLeast('admin', 'member')).toBe(true);
    expect(atLeast('owner', 'admin')).toBe(true);
    expect(atLeast('member', 'member')).toBe(true);
  });

  it('refuses a role below the one required', () => {
    expect(atLeast('member', 'admin')).toBe(false);
    expect(atLeast('admin', 'owner')).toBe(false);
  });
});
