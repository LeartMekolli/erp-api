import { CUSTOMER_ROLES, atLeast } from './customer-roles';

describe('customer roles', () => {
  it('ranks viewer, buyer, admin, owner from lowest to highest', () => {
    expect(CUSTOMER_ROLES).toEqual(['viewer', 'buyer', 'admin', 'owner']);
  });

  it('lets a role do what any lower role may', () => {
    expect(atLeast('admin', 'buyer')).toBe(true);
    expect(atLeast('owner', 'owner')).toBe(true);
    expect(atLeast('buyer', 'buyer')).toBe(true);
  });

  it('refuses a role below the one required', () => {
    expect(atLeast('viewer', 'buyer')).toBe(false);
    expect(atLeast('admin', 'owner')).toBe(false);
  });
});
