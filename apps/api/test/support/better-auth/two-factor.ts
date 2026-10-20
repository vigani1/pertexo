import { createHmac } from 'node:crypto';
import { expect } from 'vitest';
import {
  browserFrom,
  type Browser,
  type Reply,
  type useBetterAuthRealApi,
} from './real-api.support.js';

export const factorPassword = 'a long enough integration password';
type Api = ReturnType<typeof useBetterAuthRealApi>;

/** Independent RFC 6238 code generation for the real authenticator URI. */
export function authenticatorCode(uri: string): string {
  const encoded = new URL(uri).searchParams.get('secret');
  if (encoded === null) throw new Error('Authenticator secret missing');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of encoded.replace(/=+$/u, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid authenticator secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8)
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, '0');
}

export async function enrollFactor(api: Api, browser: Browser) {
  const enabled = await api.send('POST', '/v1/auth/two-factor/enable', {
    browser,
    payload: { password: factorPassword },
  });
  expect(enabled.statusCode).toBe(200);
  const setup = enabled.json<{ totpURI: string; backupCodes: string[] }>();
  expect(setup.backupCodes).toHaveLength(10);
  const pending = await api.send('GET', '/v1/auth/account-security', {
    browser,
  });
  expect(pending.json()).toMatchObject({
    twoFactor: { enabled: false, recoveryCodesRemaining: null },
  });
  const verified = await api.send('POST', '/v1/auth/two-factor/verify-totp', {
    browser,
    payload: { code: authenticatorCode(setup.totpURI) },
  });
  expect(verified.statusCode, verified.payload).toBe(200);
  return { ...setup, browser: browserFrom(verified) };
}

export function challengeCookie(reply: Reply): string {
  const cookies = reply.headers['set-cookie'];
  const challenge = (Array.isArray(cookies) ? cookies : [cookies ?? '']).find(
    (cookie) => cookie.startsWith('pertexo-auth.two_factor='),
  );
  if (challenge === undefined) throw new Error('Two-factor challenge missing');
  return challenge.split(';', 1)[0] ?? '';
}
