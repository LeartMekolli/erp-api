import { fingerprint } from './fingerprint';

const base = { userId: 'u1', method: 'POST', path: '/roles', body: { name: 'a', permissions: ['x', 'y'] } };

describe('fingerprint', () => {
  it('is a sha256 hex digest', () => {
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key order', () => {
    const reordered = { ...base, body: { permissions: ['x', 'y'], name: 'a' } };
    expect(fingerprint(reordered)).toBe(fingerprint(base));

    const nested = { ...base, body: { a: { c: 1, b: 2 } } };
    const nestedReordered = { ...base, body: { a: { b: 2, c: 1 } } };
    expect(fingerprint(nested)).toBe(fingerprint(nestedReordered));
  });

  it('differs by user, method, path and body', () => {
    const reference = fingerprint(base);
    expect(fingerprint({ ...base, userId: 'u2' })).not.toBe(reference);
    expect(fingerprint({ ...base, method: 'PUT' })).not.toBe(reference);
    expect(fingerprint({ ...base, path: '/users' })).not.toBe(reference);
    expect(fingerprint({ ...base, body: { name: 'b', permissions: ['x', 'y'] } })).not.toBe(reference);
    // Array order is meaningful.
    expect(fingerprint({ ...base, body: { name: 'a', permissions: ['y', 'x'] } })).not.toBe(reference);
  });
});
