import { generateKeyPairSync, sign } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAuthenticationMailSink } from '../../../src/authentication/mail/delivery.js';
import type { OwnedEmailProofs } from '../../../src/authentication/mail/email-proofs.js';
import { createPertexoBetterAuth } from '../../../src/authentication/better-auth/options.js';
import {
  betterAuthSocialProviders,
  configuredSocialProviders,
} from '../../../src/authentication/better-auth/social-providers.js';

const pool = new Pool({
  connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
});
const credentials = {
  google: { clientId: 'local-client', clientSecret: 'local-secret' },
};
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const proof = {
  provider: 'google' as const,
  code: 'one-use-code',
  codeVerifier: 'server-generated-pkce',
  nonce: 'expected-nonce',
  redirectUri: 'https://app.example/v1/auth/federation/social/callback/google',
  issuer: null,
};
afterAll(() => pool.end());
afterEach(() => vi.restoreAllMocks());

function idToken(overrides: Readonly<Record<string, unknown>> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'fixture-key' }),
  ).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: 'local-client',
      sub: 'verified-provider-subject',
      iat: now,
      exp: now + 300,
      nonce: proof.nonce,
      ...overrides,
    }),
  ).toString('base64url');
  const payload = `${header}.${claims}`;
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), keyPair.privateKey).toString('base64url')}`;
}
async function fixture() {
  const auth = createPertexoBetterAuth({
    pool,
    baseUrl: 'https://app.example',
    secret: 'provider-proof-with-more-than-32-characters',
    secureCookies: true,
    sessionTtlSeconds: 3600,
    trustedOrigins: ['https://app.example'],
    mail: new LocalAuthenticationMailSink(),
    emailProofs: {} as OwnedEmailProofs,
    availableLinkProviders: ['google'],
    socialProviders: credentials,
  });
  const provider = (await auth.$context).socialProviders.find(
    (item) => item.id === 'google',
  );
  if (provider?.idToken === undefined || !('jwks' in provider.idToken))
    throw new Error('Configured OIDC verifier is missing');
  vi.spyOn(provider.idToken, 'jwks').mockResolvedValue(keyPair.publicKey);
  const exchange = vi
    .spyOn(provider, 'validateAuthorizationCode')
    .mockResolvedValue({ accessToken: 'ephemeral-access', idToken: idToken() });
  const profile = vi.spyOn(provider, 'getUserInfo').mockResolvedValue({
    data: { sub: 'verified-provider-subject' },
    user: {
      email: 'verified@example.test',
      emailVerified: true,
      name: 'Verified Person',
    },
  });
  return {
    gateway: betterAuthSocialProviders(auth, credentials),
    exchange,
    profile,
  };
}

describe('configured social proof gateway', () => {
  it('advertises no provider without credentials', () => {
    expect(configuredSocialProviders(undefined)).toEqual([]);
    expect(configuredSocialProviders(credentials)).toEqual(['google']);
  });
  it('puts state, S256 PKCE, nonce and the exact callback on the real provider URL', async () => {
    const { gateway } = await fixture();
    const url = new URL(
      await gateway.authorize({ ...proof, state: 'browser-bound-state' }),
    );
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('state')).toBe('browser-bound-state');
    expect(url.searchParams.get('nonce')).toBe(proof.nonce);
    expect(url.searchParams.get('redirect_uri')).toBe(proof.redirectUri);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).not.toBe(proof.codeVerifier);
  });
  it('verifies the signed ID token before mapping the immutable account subject', async () => {
    const { gateway, exchange, profile } = await fixture();
    const result = await gateway.verify(proof);
    expect(exchange).toHaveBeenCalledWith({
      code: proof.code,
      codeVerifier: proof.codeVerifier,
      redirectURI: proof.redirectUri,
    });
    expect(profile).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'ephemeral-access',
        expectedIdTokenNonce: proof.nonce,
      }),
    );
    expect(result).toEqual({
      accountId: 'verified-provider-subject',
      email: 'verified@example.test',
      emailVerified: true,
      displayName: 'Verified Person',
    });
    expect(JSON.stringify(result)).not.toContain('ephemeral-access');
  });
  it.each([
    { nonce: 'wrong' },
    { iss: 'https://wrong.example' },
    { aud: 'another-client' },
    { exp: 1 },
  ])('refuses signed but invalid token claims: %j', async (claims) => {
    const { gateway, exchange, profile } = await fixture();
    exchange.mockResolvedValue({ idToken: idToken(claims) });
    expect(await gateway.verify(proof)).toBeUndefined();
    expect(profile).not.toHaveBeenCalled();
  });
  it('refuses an invalid signature and a mismatched callback issuer', async () => {
    const { gateway, exchange, profile } = await fixture();
    const [header, payload] = idToken().split('.');
    if (header === undefined || payload === undefined)
      throw new Error('Invalid fixture token');
    exchange.mockResolvedValue({
      idToken: `${header}.${payload}.${Buffer.alloc(256).toString('base64url')}`,
    });
    expect(await gateway.verify(proof)).toBeUndefined();
    expect(profile).not.toHaveBeenCalled();
    exchange.mockClear();
    expect(
      await gateway.verify({ ...proof, issuer: 'https://wrong.example' }),
    ).toBeUndefined();
    expect(exchange).not.toHaveBeenCalled();
  });
  it('rejects an unusable subject or malformed email instead of persisting provider data', async () => {
    const { gateway, profile } = await fixture();
    profile.mockResolvedValue({
      data: { sub: 'verified-provider-subject' },
      user: { email: 'bad-email', emailVerified: true, name: 'Person' },
    });
    expect(await gateway.verify(proof)).toBeUndefined();
    profile.mockResolvedValue({
      data: { sub: 'a'.repeat(513) },
      user: { email: 'safe@example.test', emailVerified: true, name: 'Person' },
    });
    expect(await gateway.verify(proof)).toBeUndefined();
  });
});
