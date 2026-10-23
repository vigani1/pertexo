import { expect } from 'vitest';

import { runtime } from '../lifecycle.js';
import { required, cookieValue } from '../requests.js';
import type { ProviderLinkScenario } from './contract.js';

export async function linkSecondProvider(
  scenario: ProviderLinkScenario,
  replacementCookie: string | undefined,
) {
  const { linkRequest } = scenario;
  const secondStart = await linkRequest({
    path: '/v1/auth/account-security/methods/link/start',
    method: 'POST',
    session: replacementCookie ?? '',
    binding: undefined,
    body: {
      provider: 'github',
      existingMethod: { kind: 'social', provider: 'google' },
    },
  });
  expect(secondStart.status).toBe(200);
  const secondBinding = secondStart.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('pertexo_link='))
    ?.slice('pertexo_link='.length)
    .split(';', 1)[0];
  const sourceUrl = new URL(
    ((await secondStart.json()) as { authorizationUrl: string })
      .authorizationUrl,
  );
  const sourceState = required(sourceUrl.searchParams.get('state'));
  const sourceCallback = await linkRequest({
    path: `/v1/auth/account-security/methods/link/callback/google?state=${sourceState}&code=valid:${sourceState}`,
    method: 'GET',
    session: replacementCookie ?? '',
    binding: secondBinding,
  });
  expect(sourceCallback.status).toBe(302);
  const targetUrl = new URL(
    sourceCallback.headers.get('location') ?? 'http://invalid',
  );
  expect(targetUrl.hostname).toBe('provider.test');
  const targetState = required(targetUrl.searchParams.get('state'));
  const targetCallback = await linkRequest({
    path: `/v1/auth/account-security/methods/link/callback/github?state=${targetState}&code=valid:${targetState}`,
    method: 'GET',
    session: replacementCookie ?? '',
    binding: secondBinding,
  });
  expect(targetCallback.headers.get('location')).toContain('linked=true');
  const secondReplacementCookie = cookieValue(
    targetCallback.headers.getSetCookie(),
  );
  expect(secondReplacementCookie).toBeDefined();
  expect(
    await runtime.sessions.authenticate(replacementCookie ?? ''),
  ).toBeUndefined();
  expect(
    await runtime.sessions.authenticate(secondReplacementCookie ?? ''),
  ).toBeDefined();
}
