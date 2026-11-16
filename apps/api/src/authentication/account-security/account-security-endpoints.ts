import type { Pool } from 'pg';
import type { SocialProviderGateway } from '../social-provider.types.js';
import { createGetPertexoAccountSecurityEndpoint } from './read-account-security.js';
import { createChangePertexoPasswordEndpoint } from './change-password.js';
import { createSetPertexoPasswordEndpoint } from './set-password.js';
import { createResetPertexoPasswordEndpoint } from './reset-password.js';
import { createUnlinkPertexoAccountEndpoint } from './unlink-account.js';

/**
 * Authentication-method management for the signed-in browser. Each credential
 * or method change revokes every session in its commit and then hands the
 * caller one replacement session.
 */
export function accountSecurityEndpoints(
  pool: Pool,
  availableLinkProviders: SocialProviderGateway['available'],
  organizationProtocols: readonly ('oidc' | 'saml')[],
) {
  return {
    getPertexoAccountSecurity: createGetPertexoAccountSecurityEndpoint(
      pool,
      availableLinkProviders,
    ),
    changePertexoPassword: createChangePertexoPasswordEndpoint(pool),
    setPertexoPassword: createSetPertexoPasswordEndpoint(pool),
    resetPertexoPassword: createResetPertexoPasswordEndpoint(pool),
    unlinkPertexoAccount: createUnlinkPertexoAccountEndpoint(
      pool,
      availableLinkProviders,
      organizationProtocols,
    ),
  };
}
