import { FEDERATION_WORKSPACE_STATUSES } from '../sessions/policy.js';
import type { Pool, PoolClient } from 'pg';
import type { OidcConfiguration, SamlConfiguration } from '@pertexo/contracts';
import type { FederationAttempt } from './contract.js';

type ProviderRow = Readonly<{
  provider_id: string;
  organization_id: string;
  control_workspace_id: string;
  issuer: string;
  sealed_secret: unknown;
  revision: number;
  enabled: boolean;
  domain_id: string;
  domain: string;
}> &
  (
    | Readonly<{ kind: 'oidc'; configuration: OidcConfiguration }>
    | Readonly<{ kind: 'saml'; configuration: SamlConfiguration }>
  );
type Row = ProviderRow &
  Readonly<{
    id: string;
    purpose: 'sign_in' | 'test';
    owner_user_id: string | null;
    owner_session_id: string | null;
    return_path: string;
    created_at: Date;
  }>;
function projectMaterial(row: ProviderRow) {
  return {
    domainId: row.domain_id,
    domain: row.domain,
    provider: {
      id: row.provider_id,
      organizationId: row.organization_id,
      controlWorkspaceId: row.control_workspace_id,
      issuer: row.issuer,
      ...(row.kind === 'oidc'
        ? { kind: row.kind, configuration: row.configuration }
        : { kind: row.kind, configuration: row.configuration }),
      sealedSecret: row.sealed_secret,
      revision: row.revision,
      enabled: row.enabled,
    },
  };
}
const providerSelection = `provider.id provider_id,provider.organization_id,organization.control_workspace_id,provider.issuer,provider.kind,provider.configuration,provider.sealed_secret,provider.revision,provider.enabled`;
function projectFederationAttempt(row: Row): FederationAttempt {
  return {
    ...projectMaterial(row),
    id: row.id,
    purpose: row.purpose,
    ownerUserId: row.owner_user_id,
    ownerSessionId: row.owner_session_id,
    returnPath: row.return_path,
    createdAt: row.created_at,
  };
}
export async function findFederationAttempt(
  client: Pick<PoolClient, 'query'> | Pool,
  stateDigest: Buffer,
  browserDigest: Buffer,
  { locking = false }: Readonly<{ locking?: boolean | undefined }> = {},
): Promise<FederationAttempt | undefined> {
  const row = (
    await client.query<Row>(
      `select attempt.id,attempt.created_at,attempt.purpose,attempt.owner_user_id,attempt.owner_session_id,attempt.return_path,attempt.domain_id,domain.domain,${providerSelection}
 from app.auth_federation_attempts attempt join app.auth_providers provider on provider.id=attempt.provider_id and provider.organization_id=attempt.organization_id and provider.revision=attempt.provider_revision
 join app.auth_organizations organization on organization.id=attempt.organization_id join app.workspaces control on control.id=organization.control_workspace_id
 join app.auth_domains domain on domain.id=attempt.domain_id and domain.organization_id=attempt.organization_id and domain.verified_at is not null
 where attempt.state_digest=$1 and attempt.browser_digest=$2 and attempt.consumed_at is null and attempt.expires_at>clock_timestamp() and control.status=any($3::text[]) and (provider.enabled or attempt.purpose='test') ${locking ? 'for update of attempt,provider,domain' : ''}`,
      [stateDigest, browserDigest, [...FEDERATION_WORKSPACE_STATUSES]],
    )
  ).rows[0];
  return row === undefined ? undefined : projectFederationAttempt(row);
}
export async function readFederationProvider(
  client: Pick<PoolClient, 'query'> | Pool,
  providerId: string,
  domain: string,
  { testing = false }: Readonly<{ testing?: boolean | undefined }> = {},
) {
  const row = (
    await client.query<ProviderRow>(
      `select domain.id domain_id,domain.domain,${providerSelection}
 from app.auth_providers provider join app.auth_organizations organization on organization.id=provider.organization_id join app.workspaces control on control.id=organization.control_workspace_id
 join app.auth_domains domain on domain.organization_id=organization.id and domain.verified_at is not null
 where provider.id=$1 and domain.domain=$2 and control.status=any($4::text[]) and (provider.enabled or $3::boolean)`,
      [providerId, domain, testing, [...FEDERATION_WORKSPACE_STATUSES]],
    )
  ).rows[0];
  return row === undefined ? undefined : projectMaterial(row);
}
