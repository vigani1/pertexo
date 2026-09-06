import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import type {
  OidcAuthorizationRequest,
  OidcProviderPort,
} from '../../src/identity/index.js';

export type HttpSessionCookies = Readonly<{
  rawSession: string;
  csrf: string;
  cookieHeader: string;
}>;

export type FakeOidcProviderOptions = Readonly<{
  issuer: string;
  clientId: string;
  displayNamePrefix: string;
}>;

export function createFakeOidcProvider(
  options: FakeOidcProviderOptions,
): OidcProviderPort {
  let latestRequest: OidcAuthorizationRequest | undefined;
  const issuerHost = new URL(options.issuer).hostname;
  return Object.freeze({
    authorizationUrl(request: OidcAuthorizationRequest): string {
      latestRequest = request;
      const url = new URL(`${options.issuer}/authorize`);
      url.searchParams.set('client_id', request.clientId);
      url.searchParams.set('redirect_uri', request.redirectUri);
      url.searchParams.set('scope', request.scopes.join(' '));
      url.searchParams.set('state', request.state);
      url.searchParams.set('nonce', request.nonce);
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set(
        'code_challenge_method',
        request.codeChallengeMethod,
      );
      return url.toString();
    },
    exchangeCode(input: {
      code: string;
      codeVerifier: string;
      redirectUri: string;
    }) {
      void input.codeVerifier;
      void input.redirectUri;
      const request = latestRequest;
      if (request === undefined)
        throw new Error('authorization was not started');
      return Promise.resolve({
        issuer: options.issuer,
        subject: input.code,
        audience: options.clientId,
        nonce: request.nonce,
        email: `${input.code}@${issuerHost}`,
        displayName: `${options.displayNamePrefix} ${input.code}`,
        emailVerified: true,
      });
    },
  });
}

export async function loginThroughOidc(
  application: NestFastifyApplication,
  subject: string,
): Promise<HttpSessionCookies> {
  const start = await application.inject({
    method: 'GET',
    url: '/v1/auth/oidc/start',
  });
  if (start.statusCode !== 200)
    throw new Error(
      `OIDC start failed: ${String(start.statusCode)} ${start.payload}`,
    );
  const state = start.json<{ authorizationUrl: string }>().authorizationUrl;
  const stateValue = new URL(state).searchParams.get('state');
  if (stateValue === null) throw new Error('OIDC state was not returned');
  const browserBinding = cookieValue(
    [String(start.headers['set-cookie'])],
    'pertexo_oidc_binding',
  );
  const callback = await application.inject({
    method: 'GET',
    url: `/v1/auth/oidc/callback?code=${encodeURIComponent(subject)}&state=${encodeURIComponent(stateValue)}`,
    headers: {
      cookie: `pertexo_oidc_binding=${encodeURIComponent(browserBinding)}`,
    },
  });
  if (callback.statusCode !== 204)
    throw new Error(
      `OIDC callback failed: ${String(callback.statusCode)} ${callback.payload}`,
    );
  return sessionCookies(callback.headers['set-cookie']);
}

function sessionCookies(
  header: string | string[] | undefined,
): HttpSessionCookies {
  const values = Array.isArray(header) ? header : [header ?? ''];
  const flattened = values.flatMap((value) => value.split(/,(?=[^;]+?=)/u));
  const rawSession = cookieValue(flattened, 'pertexo_session');
  const csrf = cookieValue(flattened, 'pertexo_csrf');
  return {
    rawSession,
    csrf,
    cookieHeader: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
  };
}

function cookieValue(values: readonly string[], name: string): string {
  const prefix = `${name}=`;
  for (const value of values) {
    const pair = value.split(';', 1)[0]?.trim();
    if (pair?.startsWith(prefix))
      return decodeURIComponent(pair.slice(prefix.length));
  }
  throw new Error(`${name} cookie was not returned`);
}
