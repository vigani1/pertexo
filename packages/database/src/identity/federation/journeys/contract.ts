import type { OidcConfiguration, SamlConfiguration } from '@pertexo/contracts';
export type OrganizationProvider = Readonly<{
  id: string;
  organizationId: string;
  controlWorkspaceId: string;
  issuer: string;
  sealedSecret: unknown;
  revision: number;
  enabled: boolean;
}> &
  (
    | Readonly<{ kind: 'oidc'; configuration: OidcConfiguration }>
    | Readonly<{ kind: 'saml'; configuration: SamlConfiguration }>
  );
export type FederationAttempt = Readonly<{
  id: string;
  purpose: 'sign_in' | 'test';
  provider: OrganizationProvider;
  domainId: string;
  domain: string;
  ownerUserId: string | null;
  ownerSessionId: string | null;
  returnPath: string;
  createdAt: Date;
}>;
export type FederationIdentity = Readonly<{
  subject: string;
  email: string;
  displayName: string;
}>;
export type FederationCompletion =
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'tested'; returnPath: string }>
  | Readonly<{ kind: 'signed_in'; token: string; returnPath: string }>;
export type StartFederationJourney = Readonly<{
  id: string;
  providerId: string;
  providerRevision: number;
  domainId: string;
  purpose: 'sign_in' | 'test';
  ownerUserId?: string;
  ownerSessionId?: string;
  stateDigest: Buffer;
  browserDigest: Buffer;
  returnPath: string;
}>;
