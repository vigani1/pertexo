import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { mailedMessages } from '../mail.js';
import { runtime } from '../lifecycle.js';
import { required, authRequest, cookieValue } from '../requests.js';
import type { ProviderLinkScenario } from './contract.js';

export async function createVerifiedLinkingBrowser() {
  const email = `linked-${randomUUID()}@example.test`;
  const password = 'correct horse battery staple';
  const signup = await authRequest('/v1/auth/sign-up/email', {
    name: 'Linking Test',
    email,
    password,
  });
  expect(signup.status).toBe(200);
  const verification = mailedMessages(email).find(
    (item) => item.purpose === 'verification',
  );
  expect(verification).toBeDefined();
  expect(
    (
      await runtime.auth.handler(
        new Request(verification?.url ?? 'http://invalid'),
      )
    ).status,
  ).toBe(302);
  const signIn = await authRequest('/v1/auth/sign-in/email', {
    email,
    password,
  });
  expect(signIn.status).toBe(200);
  const originalCookie = cookieValue(signIn.headers.getSetCookie());
  expect(originalCookie).toBeDefined();

  return { email, password, originalCookie };
}

export async function startProviderLink(scenario: ProviderLinkScenario) {
  const { password, originalCookie, linkRequest } = scenario;
  const wrongPassword = await linkRequest({
    path: '/v1/auth/account-security/methods/link/start',
    method: 'POST',
    session: originalCookie ?? '',
    binding: undefined,
    body: {
      provider: 'google',
      existingMethod: { kind: 'password', password: 'wrong' },
    },
  });
  expect(wrongPassword.status).toBe(403);
  const started = await linkRequest({
    path: '/v1/auth/account-security/methods/link/start',
    method: 'POST',
    session: originalCookie ?? '',
    binding: undefined,
    body: {
      provider: 'google',
      existingMethod: { kind: 'password', password },
    },
  });
  expect(started.status).toBe(200);
  const binding = started.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('pertexo_link='))
    ?.slice('pertexo_link='.length)
    .split(';', 1)[0];
  expect(binding).toBeDefined();
  const startedBody = (await started.json()) as {
    authorizationUrl: string;
  };
  const state = required(
    new URL(startedBody.authorizationUrl).searchParams.get('state'),
  );
  expect(state).toBeTruthy();
  const callback = `/v1/auth/account-security/methods/link/callback/google?state=${state}&code=valid:${state}`;
  const otherBrowser = await linkRequest({
    path: callback,
    method: 'GET',
    session: originalCookie ?? '',
    binding: 'wrong-binding',
  });
  expect(otherBrowser.headers.get('location')).toContain('linkError=true');

  return { binding, callback };
}
