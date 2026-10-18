import type {
  FederationSettings,
  OidcConfiguration,
  SamlConfiguration,
} from '@pertexo/contracts';
export type FederationScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type OrganizationSnapshot = NonNullable<
  FederationSettings['organization']
>;
export type OrganizationRow = Readonly<{
  id: string;
  control_workspace_id: string;
  name: string;
  revision: number;
}>;
export type ProviderRow = Readonly<{
  id: string;
  organization_id: string;
  name: string;
  issuer: string;
  sealed_secret: unknown;
  enabled: boolean;
  revision: number;
}> &
  (
    | Readonly<{ kind: 'oidc'; configuration: OidcConfiguration }>
    | Readonly<{ kind: 'saml'; configuration: SamlConfiguration }>
  );
export type DomainRow = Readonly<{
  id: string;
  organization_id: string;
  domain: string;
  challenge: string | null;
  challenge_expires_at: Date | null;
  verified_at: Date | null;
  require_sso: boolean;
  revision: number;
}>;
export class FederationConflictError extends Error {
  constructor(
    public readonly reason:
      | 'owner_required'
      | 'stale'
      | 'limit'
      | 'unavailable'
      | 'domain_claimed'
      | 'dns_unverified'
      | 'recovery_required'
      | 'provider_untested',
    message: string,
  ) {
    super(message);
    this.name = 'FederationConflictError';
  }
}
