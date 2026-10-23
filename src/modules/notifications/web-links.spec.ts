import { identityLink, webLink } from './web-links';

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

  it('falls back to the staff app when the workspace has no customer site', () => {
    expect(identityLink({ ...base, customerSiteOrigin: null, forCustomer: true }, '/reset-password', 'abc')).toBe(
      'https://acme.app.example/reset-password#token=abc',
    );
  });

  it('always sends staff to the staff app', () => {
    expect(identityLink({ ...base, customerSiteOrigin: 'https://shop.test', forCustomer: false }, '/reset-password', 'abc')).toBe(
      'https://acme.app.example/reset-password#token=abc',
    );
  });
});
