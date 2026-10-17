import { createHash } from 'node:crypto';
import { issueOpaqueToken, parseOpaqueToken } from './opaque-token';

const TENANT = '01a145c3-7e73-728d-9d82-1f426e70d11e';

describe('opaque tokens', () => {
  it('issues <tenantId>.<43-char base64url secret> and a sha256 hex hash of the secret', () => {
    const { token, hash } = issueOpaqueToken(TENANT);
    const [prefix, secret] = token.split('.');

    expect(prefix).toBe(TENANT);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(createHash('sha256').update(secret ?? '').digest('hex'));
  });

  it('parses back to the same tenant and hash', () => {
    const { token, hash } = issueOpaqueToken(TENANT);

    expect(parseOpaqueToken(token)).toEqual({ tenantId: TENANT, hash });
  });

  it.each([
    ['no separator', 'abc'],
    ['a prefix that is not a uuid', 'tenant.c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2Vj'],
    ['an empty secret', `${TENANT}.`],
    ['a secret of the wrong length', `${TENANT}.short`],
    ['an extra separator', `${TENANT}.aaaa.bbbb`],
    ['an empty string', ''],
  ])('returns null for %s', (_label, token) => {
    expect(parseOpaqueToken(token)).toBeNull();
  });

  it('never issues the same secret twice', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => issueOpaqueToken(TENANT).token));

    expect(tokens.size).toBe(100);
  });
});
