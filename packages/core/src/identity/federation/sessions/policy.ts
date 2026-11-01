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
  directoryAllowed: boolean;
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
      provider.directoryAllowed &&
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

export type StoredSessionProof = Readonly<{
  authentication_method: 'credential' | 'social' | 'organization';
  federation_provider_id: string | null;
  federation_provider_revision: number | null;
}>;
export function sessionProof(
  session: StoredSessionProof,
): SessionAuthenticationProof {
  const organizationProof =
    session.authentication_method === 'organization' &&
    session.federation_provider_id !== null &&
    session.federation_provider_revision !== null;
  return organizationProof
    ? {
        method: 'organization',
        providerId: session.federation_provider_id,
        providerRevision: session.federation_provider_revision,
      }
    : {
        method:
          session.authentication_method === 'social' ? 'social' : 'credential',
      };
}
export function accountPolicy(
  account: Readonly<{
    status: string;
    email_verified: boolean;
    organization_id: string | null;
    require_sso: boolean | null;
    control_owner: boolean;
    password_present: boolean;
  }>,
): AuthenticationPolicy {
  const recoveryOwner =
    (account.require_sso ?? false) &&
    account.email_verified &&
    account.control_owner &&
    account.password_present;
  return {
    active: account.status === 'active',
    enforcedOrganizationId:
      (account.require_sso ?? false) ? account.organization_id : null,
    verifiedOrganizationId: account.organization_id,
    recoveryOwner,
  };
}
