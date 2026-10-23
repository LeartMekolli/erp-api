import { UnauthorizedException } from '@nestjs/common';
import { testGoogleKeys } from '../../../test/google';
import type { TestGoogleKeys } from '../../../test/google';
import { GoogleTokenVerifier } from './google-token-verifier';

const CLIENT = 'client-a.apps.example.test';

describe('GoogleTokenVerifier', () => {
  let keys: TestGoogleKeys;
  let verifier: GoogleTokenVerifier;

  beforeAll(async () => {
    keys = await testGoogleKeys();
    verifier = new GoogleTokenVerifier(keys.keySet);
  });

  const claims = { aud: CLIENT, sub: 'google-subject-1', email: 'Ada@Example.test', name: 'Ada' };

  it("reads a valid token's subject, lowercased email, verification and name", async () => {
    await expect(verifier.verify(await keys.mint(claims), [CLIENT])).resolves.toEqual({
      subject: 'google-subject-1',
      email: 'ada@example.test',
      emailVerified: true,
      name: 'Ada',
    });
  });

  it('accepts either issuer Google uses, any of the configured client ids, and a token with no name', async () => {
    const token = await keys.mint({ ...claims, iss: 'accounts.google.com', name: undefined });
    await expect(verifier.verify(token, ['other-client', CLIENT])).resolves.toMatchObject({ name: null });
  });

  it('reports an unverified email rather than refusing it', async () => {
    const token = await keys.mint({ ...claims, email_verified: false });
    await expect(verifier.verify(token, [CLIENT])).resolves.toMatchObject({ emailVerified: false });
  });

  it.each([
    ['another client id', async () => keys.mint({ ...claims, aud: 'client-b.apps.example.test' })],
    ['another issuer', async () => keys.mint({ ...claims, iss: 'https://issuer.example.test' })],
    ['an expired token', async () => keys.mint({ ...claims, expiresAt: Math.floor(Date.now() / 1000) - 60 })],
    ['no email', async () => keys.mint({ ...claims, email: undefined })],
    ['a key Google did not publish',async () => (await testGoogleKeys()).mint(claims)],
    ['something that is not a token', () => Promise.resolve('not-a-token')],
  ])('refuses %s', async (_case, token) => {
    await expect(verifier.verify(await token(), [CLIENT])).rejects.toThrow(UnauthorizedException);
  });

  it('refuses every token when no client id is configured', async () => {
    await expect(verifier.verify(await keys.mint(claims), [])).rejects.toThrow(UnauthorizedException);
  });
});
