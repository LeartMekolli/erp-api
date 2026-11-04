import { customerBillingLink, customerOrderLink, identityLink, webLink } from './web-links';

describe('webLink', () => {
  it('puts the slug in the host and the token in the fragment', () => {
    expect(webLink('http://{tenant}.localhost:5173', 'acme', '/accept-invitation', 'tenant-id.secret')).toBe(
      'http://acme.localhost:5173/accept-invitation#token=tenant-id.secret',
    );
  });

  it('does not double the slash when the template ends with one', () => {
    expect(webLink('https://{tenant}.app.example/', 'acme', '/reset-password', 'abc')).toBe(
      'https://acme.app.example/reset-password#token=abc',
    );
  });

  it('encodes the token', () => {
    expect(webLink('http://{tenant}.localhost:5173', 'acme', '/reset-password', 'a b+c/&d')).toBe(
      'http://acme.localhost:5173/reset-password#token=a%20b%2Bc%2F%26d',
    );
  });
});

describe('identityLink', () => {
  const base = { webTemplate: 'https://{tenant}.app.example', slug: 'acme' };

  it("sends customer people to the workspace's customer site", () => {
    expect(identityLink({ ...base, customerSiteOrigin: 'https://shop.test', forCustomer: true }, '/accept-invitation', 'abc')).toBe(
      'https://shop.test/accept-invitation#token=abc',
    );
  });

  it('has no link for customer people when the workspace has no customer site', () => {
    expect(identityLink({ ...base, customerSiteOrigin: null, forCustomer: true }, '/reset-password', 'abc')).toBeNull();
  });

  it('always sends staff to the staff app', () => {
    expect(identityLink({ ...base, customerSiteOrigin: 'https://shop.test', forCustomer: false }, '/reset-password', 'abc')).toBe(
      'https://acme.app.example/reset-password#token=abc',
    );
  });
});

describe('customer return links', () => {
  const site = { apiUrl: 'https://api.example/', customerSiteOrigin: 'https://shop.test/' };
  const noSite = { apiUrl: 'https://api.example/', customerSiteOrigin: null };

  it("sends a customer back to the workspace's customer site", () => {
    expect(customerOrderLink(site, 'o1', 'paid')).toBe('https://shop.test/orders/o1?payment=success');
    expect(customerOrderLink(site, 'o1', 'cancelled')).toBe('https://shop.test/orders/o1?payment=cancelled');
    expect(customerBillingLink(site, 'paid', '?pack=done')).toBe('https://shop.test/billing?pack=done');
    expect(customerBillingLink(site, 'back')).toBe('https://shop.test/billing');
  });

  it("sends a customer to the API's page when the workspace has no customer site, never the staff app", () => {
    expect(customerOrderLink(noSite, 'o1', 'paid')).toBe('https://api.example/payment-return?outcome=paid');
    expect(customerOrderLink(noSite, 'o1', 'cancelled')).toBe('https://api.example/payment-return?outcome=cancelled');
    expect(customerBillingLink(noSite, 'cancelled', '?subscription=cancelled')).toBe(
      'https://api.example/payment-return?outcome=cancelled',
    );
    expect(customerBillingLink(noSite, 'back')).toBe('https://api.example/payment-return?outcome=back');
  });
});
