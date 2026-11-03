import {
  createOAuth2TokenService as createConnectionTokenService,
  type OAuth2TokenServiceDependencies,
} from '@pertexo/core/connections';
import {
  decodeClientSettings,
  OAuth2TokenFailure,
  requestOAuth2Token,
} from '@pertexo/integrations/server';
import type { SecureHttpClient } from '@pertexo/secrets/server';

type Dependencies = Omit<
  OAuth2TokenServiceDependencies,
  'requestToken' | 'decodeClientSettings' | 'TokenFailure'
> &
  Readonly<{ httpClient: Pick<SecureHttpClient, 'execute'> }>;

/** Binds provider protocol and errors to the connection lifecycle without a reverse dependency. */
export function createOAuth2TokenService({
  httpClient,
  ...dependencies
}: Dependencies) {
  return createConnectionTokenService({
    ...dependencies,
    decodeClientSettings,
    TokenFailure: OAuth2TokenFailure,
    requestToken: (settings, secret, request) =>
      requestOAuth2Token(httpClient, settings, secret, request),
  });
}
