import { federationProtocolSchema } from '@pertexo/contracts';
import type { RateLimitEndpointClass } from '@pertexo/rate-limit/server';

/**
 * Which budget an authentication request counts against. Routes where a
 * password, code or emailed token can be guessed keep the tight
 * `identity_start`; starting and finishing a sign-in at an identity provider
 * guesses nothing, so it has its own budget, sized for an office behind one
 * address. A path missing here falls back to the tight budget, never a looser one.
 */
export function signInBudget(
  method: string,
  pathname: string,
  providerFormCallback: boolean,
): RateLimitEndpointClass {
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  if (isFederatedCallback(pathname)) return 'federated_sign_in_callback';
  if (!unsafe)
    return pathname === DISCOVERY_PATH
      ? 'sign_in_page_read'
      : 'identity_callback';
  if (FEDERATED_START_PATHS.has(pathname)) return 'federated_sign_in_start';
  return providerFormCallback ? 'identity_callback' : 'identity_start';
}

const FEDERATION_PREFIX = '/v1/auth/federation';
const DISCOVERY_PATH = `${FEDERATION_PREFIX}/discover`;
const SOCIAL_CALLBACK_PREFIX = `${FEDERATION_PREFIX}/social/callback/`;

const FEDERATED_START_PATHS = new Set([
  '/v1/auth/sign-in/social',
  ...federationProtocolSchema.options.flatMap((protocol) => [
    `${FEDERATION_PREFIX}/${protocol}/start`,
    `${FEDERATION_PREFIX}/${protocol}/test`,
  ]),
]);

const ORGANIZATION_CALLBACK_PATHS = new Set(
  federationProtocolSchema.options.map(
    (protocol) => `${FEDERATION_PREFIX}/${protocol}/callback`,
  ),
);

function isFederatedCallback(pathname: string): boolean {
  return (
    ORGANIZATION_CALLBACK_PATHS.has(pathname) ||
    pathname.startsWith(SOCIAL_CALLBACK_PREFIX)
  );
}
