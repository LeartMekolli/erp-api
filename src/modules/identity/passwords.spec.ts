import * as argon2 from 'argon2';
import {
  hashPassword,
  needsRehash,
  passwordSchema,
  verifyAgainstDummy,
  verifyPassword,
} from './passwords';

describe('passwords', () => {
  it('hashes with argon2id at the pinned parameters, stored in the hash (F1)', async () => {
    // $argon2id$v=19$<params>$<salt>$<hash>; the library chooses the order of params.
    const [, algorithm, version, params] = (await hashPassword('correct horse battery')).split('$');
    const parsed = Object.fromEntries((params ?? '').split(',').map((pair) => pair.split('=')));

    expect({ algorithm, version, parsed }).toEqual({
      algorithm: 'argon2id',
      version: 'v=19',
      parsed: { m: '19456', t: '2', p: '1' },
    });
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');

    await expect(verifyPassword(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'correct horse batterY')).resolves.toBe(false);
  });

  it('returns false rather than throwing for a hash it cannot parse', async () => {
    await expect(verifyPassword('not-a-hash', 'anything at all')).resolves.toBe(false);
  });

  it('flags a hash made with weaker parameters for rehash', async () => {
    const weak = await argon2.hash('correct horse battery', {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 1,
      parallelism: 1,
    });

    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword('correct horse battery'))).toBe(false);
  });

  it.each([
    ['11 characters', 'a'.repeat(11), false],
    ['12 characters', 'a'.repeat(12), true],
    ['128 characters', 'a'.repeat(128), true],
    ['129 characters', 'a'.repeat(129), false],
  ])('passwordSchema with %s', (_label, value, valid) => {
    expect(passwordSchema.safeParse(value).success).toBe(valid);
  });

  it('spends a verification on unknown emails and always says no', async () => {
    await expect(verifyAgainstDummy('whatever password')).resolves.toBe(false);
  });
});
