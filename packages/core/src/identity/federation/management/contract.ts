import type {
  FederationSettings,
  OidcConfiguration,
  SamlConfiguration,
} from '@pertexo/contracts';
import type { DelegatedRole } from '@pertexo/workflow-model';

export type FederationScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type OrganizationSnapshot = NonNullable<
  FederationSettings['organization']
>;

export type FederationCommand = FederationScope &
  Readonly<{ idempotencyKey: string; expectedRevision: number }>;

export type DomainChallengeInput = FederationScope &
  Readonly<{ domainId: string }>;

export type CreateOrganizationInput = FederationScope &
  Readonly<{ name: string; idempotencyKey: string }>;

export type LinkWorkspaceInput = FederationCommand &
  Readonly<{ targetWorkspaceId: string; defaultRole: DelegatedRole }>;

export type CreateDomainInput = FederationCommand &
  Readonly<{ domain: string }>;

/** A command on one domain: renewing its challenge, or removing it. */
export type DomainCommand = FederationCommand & Readonly<{ domainId: string }>;

export type VerifyDomainInput = DomainCommand &
  Readonly<{ observedChallenge: string }>;

export type ConfigureEnforcementInput = DomainCommand &
  Readonly<{ required: boolean }>;

export type SealedSecret = Readonly<Record<string, unknown>>;

type ProviderValues = Readonly<{ name: string; enabled: boolean }> &
  (
    | Readonly<{ kind?: 'oidc'; configuration: OidcConfiguration }>
    | Readonly<{ kind: 'saml'; configuration: SamlConfiguration }>
  );

/** The API seals the secret and computes a purpose-bound HMAC for exact retries. Neither plaintext nor an unkeyed secret digest crosses this boundary. */
export type CreateProviderInput = FederationCommand &
  Readonly<{ issuer: string; name: string; enabled: boolean }> &
  (
    | Readonly<{
        kind?: 'oidc';
        configuration: OidcConfiguration;
        sealSecret: (providerId: string) => SealedSecret;
        secretFingerprint: string;
      }>
    | Readonly<{ kind: 'saml'; configuration: SamlConfiguration }>
  );

export type UpdateProviderInput = FederationCommand &
  ProviderValues &
  Readonly<{
    providerId: string;
    sealedSecret?: SealedSecret;
    secretFingerprint?: string;
  }>;

export type RemoveProviderInput = FederationCommand &
  Readonly<{ providerId: string }>;
