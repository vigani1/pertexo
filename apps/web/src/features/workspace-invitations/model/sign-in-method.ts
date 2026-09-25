import type { AuthenticationCapabilitiesResponse } from '@pertexo/contracts/schemas/identity-workspace';

/**
 * How the invited account is proven: a fresh sign-in by the session
 * authority (Better Auth), or the legacy OIDC journey when that is the only
 * sign-in the deployment offers (ADR 038 and ADR 043).
 */
export type InvitationSignInMethod = 'session' | 'oidc';

/** Unknown capabilities mean the product's own sign-in, not legacy OIDC. */
export function invitationSignInMethod(
  capabilities: AuthenticationCapabilitiesResponse | undefined,
): InvitationSignInMethod {
  if (capabilities === undefined) return 'session';
  return capabilities.password.enabled ||
    capabilities.socialProviders.length > 0
    ? 'session'
    : 'oidc';
}
