import { describe, expect, it } from 'vitest';
import { landProviderFormCallback } from '../../../src/authentication/journeys/form-callback.js';

function callback(
  body: string,
  path = '/v1/auth/federation/social/callback/apple',
  contentType = 'application/x-www-form-urlencoded',
) {
  return landProviderFormCallback(
    new Request(`https://app.example${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    }),
  );
}

describe('cross-site provider form landing', () => {
  it.each([
    '/v1/auth/federation/social/callback/apple',
    '/v1/auth/account-security/methods/link/callback/apple',
  ])(
    'lands on the same callback without trusting front-channel profile or tokens: %s',
    async (path) => {
      const response = await callback(
        'state=bound&code=one-use&user=private-profile&id_token=untrusted',
        path,
      );
      expect(response?.status).toBe(303);
      expect(response?.headers.get('location')).toBe(
        `https://app.example${path}?state=bound&code=one-use`,
      );
      expect(response?.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response?.headers.get('cache-control')).toBe('no-store');
      expect(response?.headers.has('set-cookie')).toBe(false);
    },
  );
  it('limits bytes and rejects ambiguous proofs or the wrong encoding', async () => {
    expect((await callback(`unused=${'a'.repeat(32768)}`))?.status).toBe(413);
    expect((await callback('state=one&state=two'))?.status).toBe(400);
    expect(
      (
        await callback(
          'state=one',
          '/v1/auth/federation/social/callback/apple?state=two',
        )
      )?.status,
    ).toBe(400);
    expect((await callback('{}', undefined, 'application/json'))?.status).toBe(
      400,
    );
    expect((await callback(`code=${'a'.repeat(4097)}`))?.status).toBe(400);
  });
  it('does not own other cross-site authentication posts', async () => {
    expect(
      await callback('state=one', '/v1/auth/federation/social/callback/google'),
    ).toBeUndefined();
    expect(
      await callback('state=one', '/v1/auth/sign-in/email'),
    ).toBeUndefined();
  });
});
