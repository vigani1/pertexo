export const FEDERATION_WORKSPACE_STATUSES = [
  'active',
  'suspended',
  'pending_deletion',
] as const;
export type SessionAuthenticationProof =
  | Readonly<{ method: 'credential' | 'social' }>
  | Readonly<{
      method: 'organization';
      providerId: string;
      providerRevision: number;
    }>;
export type AuthenticationPolicy = Readonly<{
  active: boolean;
  enforcedOrganizationId: string | null;
  recoveryOwner: boolean;
  verifiedOrganizationId: string | null;
}>;
export type CurrentProvider = Readonly<{
  organizationId: string;
  enabled: boolean;
  revision: number;
}>;
/** Every entry and lookup uses this rule; social identity never satisfies required organization SSO. */
export function authenticationAllowed(
  policy: AuthenticationPolicy,
  proof: SessionAuthenticationProof,
  provider?: CurrentProvider,
): boolean {
  if (!policy.active) return false;
  if (proof.method === 'organization')
    return (
      provider !== undefined &&
      provider.enabled &&
      provider.revision === proof.providerRevision &&
      provider.organizationId === policy.verifiedOrganizationId &&
      (policy.enforcedOrganizationId === null ||
        policy.enforcedOrganizationId === provider.organizationId)
    );
  return (
    policy.enforcedOrganizationId === null ||
    (proof.method === 'credential' && policy.recoveryOwner)
  );
}

export function identityEmailChangeAllowed(
  policy: AuthenticationPolicy,
): boolean {
  return (
    policy.active &&
    (policy.enforcedOrganizationId === null || policy.recoveryOwner)
  );
}
