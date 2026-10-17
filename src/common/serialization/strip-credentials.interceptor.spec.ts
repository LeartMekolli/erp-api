import { stripCredentials } from './strip-credentials.interceptor';

describe('stripCredentials', () => {
  it('removes hash, password and secret fields at any depth, inside arrays too', () => {
    const body = {
      id: 'u1',
      passwordHash: '$argon2id$...',
      profile: { keyHash: 'abc', token_hash: 'def', name: 'Ada' },
      accounts: [{ clientSecret: 's', label: 'one' }, { password: 'p', label: 'two' }],
    };

    expect(stripCredentials(body)).toEqual({
      id: 'u1',
      profile: { name: 'Ada' },
      accounts: [{ label: 'one' }, { label: 'two' }],
    });
  });

  it('keeps the tokens a login response is meant to carry', () => {
    const session = { access_token: 'a', refresh_token: 'r', expires_at: 'x' };

    expect(stripCredentials(session)).toEqual(session);
  });

  it('does not change the object it was given', () => {
    const body = { passwordHash: 'h', name: 'Ada' };

    stripCredentials(body);

    expect(body).toEqual({ passwordHash: 'h', name: 'Ada' });
  });

  it.each([
    ['a string', 'hello'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('leaves %s untouched', (_label, value) => {
    expect(stripCredentials(value)).toBe(value);
  });

  it('leaves non-plain objects such as dates untouched', () => {
    const when = new Date(0);

    expect(stripCredentials({ when }).when).toBe(when);
  });
});
