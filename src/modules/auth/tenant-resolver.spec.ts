import { resolveTenantSlug } from './tenant-resolver';

describe('resolveTenantSlug', () => {
  it.each([
    ['a subdomain with a port', 'acme.localhost:3000', undefined, 'acme'],
    ['a subdomain without a port', 'acme.localhost', undefined, 'acme'],
    ['an uppercase host', 'ACME.Localhost', undefined, 'acme'],
    ['the bare base domain, falling back to the workspace', 'localhost:3000', 'acme', 'acme'],
    ['no host at all', undefined, 'acme', 'acme'],
    ['a workspace with stray case and spaces', 'localhost', ' Acme ', 'acme'],
    ['www, which is not a tenant', 'www.localhost', undefined, undefined],
    ['a nested subdomain, which is not a tenant', 'a.b.localhost', undefined, undefined],
    ['an unrelated host', 'acme.example.com', undefined, undefined],
    ['an empty workspace', 'localhost', '  ', undefined],
    ['a subdomain winning over a different workspace', 'acme.localhost', 'other', 'acme'],
  ])('handles %s', (_label, host, workspace, expected) => {
    expect(resolveTenantSlug(host, workspace, 'localhost')).toBe(expected);
  });

  it('works with a multi-label base domain', () => {
    expect(resolveTenantSlug('acme.erp.example.com', undefined, 'erp.example.com')).toBe('acme');
    expect(resolveTenantSlug('erp.example.com', undefined, 'erp.example.com')).toBeUndefined();
  });
});
