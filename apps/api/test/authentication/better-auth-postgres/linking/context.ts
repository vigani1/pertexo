import { createBetterAuthRuntime } from '../../../../src/authentication/better-auth/runtime.js';
import type { SocialProviderGateway } from '../../../../src/authentication/providers/contract.js';

import { apiUrl } from '../environment.js';
import { mail } from '../mail.js';
import type { createVerifiedLinkingBrowser } from './browser.js';

export function createProviderLinkScenario({
  email,
  password,
  originalCookie,
}: Awaited<ReturnType<typeof createVerifiedLinkingBrowser>>) {
  const authorizations = new Map<
    string,
    { codeVerifier: string; nonce: string; redirectUri: string }
  >();
  const bothProviderProofs = Promise.withResolvers<undefined>();
  const proofState = { count: 0, gated: false };
  const gateway: SocialProviderGateway = {
    available: ['google', 'github'],
    authorize: (input) => {
      authorizations.set(`${input.provider}:${input.state}`, input);
      return Promise.resolve(
        `https://provider.test/authorize?state=${input.state}`,
      );
    },
    verify: (input) => {
      const state = input.code.split(':', 2)[1] ?? '';
      const expected = authorizations.get(`${input.provider}:${state}`);
      if (
        expected?.codeVerifier !== input.codeVerifier ||
        expected.nonce !== input.nonce ||
        expected.redirectUri !== input.redirectUri ||
        input.issuer !== null
      )
        return Promise.resolve(undefined);
      const identity = {
        accountId: `${input.provider}-subject-${email}`,
        email,
        emailVerified: true,
      };
      if (proofState.gated) {
        proofState.count += 1;
        if (proofState.count === 2) bothProviderProofs.resolve(undefined);
        return bothProviderProofs.promise.then(() => identity);
      }
      return Promise.resolve(identity);
    },
  };
  const linkingRuntime = createBetterAuthRuntime({
    signUpMode: 'open',
    baseUrl: 'http://pertexo.test',
    secret: 'postgres-integration-secret-with-at-least-32-characters',
    database: {
      connectionString: apiUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 2,
    },
    secureCookies: false,
    sessionTtlSeconds: 3_600,
    trustedOrigins: ['http://pertexo.test'],
    mail,
    linkProviderGateway: gateway,
  });
  const csrf = 'link-csrf-token-with-more-than-thirty-two-characters';
  const linkRequest = ({
    path,
    method,
    session,
    binding,
    body,
  }: Readonly<{
    path: string;
    method: 'GET' | 'POST';
    session: string;
    binding?: string | undefined;
    body?: object | undefined;
  }>) =>
    linkingRuntime.auth.handler(
      new Request(`http://pertexo.test${path}`, {
        method,
        headers: {
          origin: 'http://pertexo.test',
          cookie: `pertexo_session=${session}; pertexo_csrf=${csrf}${binding === undefined ? '' : `; pertexo_link=${binding}`}`,
          'x-csrf-token': csrf,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  return {
    email,
    password,
    originalCookie,
    bothProviderProofs,
    proofState,
    linkingRuntime,
    linkRequest,
  };
}
