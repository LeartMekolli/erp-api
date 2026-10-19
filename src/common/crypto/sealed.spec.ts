import { deriveKey, open, seal } from './sealed';

const key = deriveKey('a'.repeat(32), 'notification-secrets');

describe('sealed secrets', () => {
  it('derives a 32-byte key, different per info label', () => {
    expect(key).toHaveLength(32);
    expect(deriveKey('a'.repeat(32), 'something-else').equals(key)).toBe(false);
  });

  it('round-trips', () => {
    expect(open(seal('https://acme.example/accept#token=abc', key), key)).toBe(
      'https://acme.example/accept#token=abc',
    );
  });

  it('lays out a 12-byte IV, a 16-byte tag, then the ciphertext', () => {
    expect(seal('hello', key)).toHaveLength(12 + 16 + Buffer.byteLength('hello'));
  });

  it('two seals of one text differ', () => {
    expect(seal('same', key).equals(seal('same', key))).toBe(false);
  });

  it('a flipped byte throws', () => {
    const sealed = seal('secret', key);
    sealed[sealed.length - 1] ^= 0x01;
    expect(() => open(sealed, key)).toThrow();
  });

  it('another key throws', () => {
    const other = deriveKey('b'.repeat(32), 'notification-secrets');
    expect(() => open(seal('secret', key), other)).toThrow();
  });
});
