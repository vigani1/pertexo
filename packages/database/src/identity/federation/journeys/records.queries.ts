import { and, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import type { OidcConfiguration, SamlConfiguration } from '@pertexo/contracts';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { workspaces } from '../../../schema/foundation.js';
import { authDomains } from '../../../schema/identity/federation/domains.js';
import { authProviders } from '../../../schema/identity/federation/providers.js';
import { authOrganizations } from '../../../schema/identity/federation/organizations.js';
import { authFederationAttempts } from '../../../schema/identity/federation/journeys.js';
import { FEDERATION_WORKSPACE_STATUSES } from '../sessions/policy.js';
import type { FederationAttempt } from './contract.js';

const provider = alias(authProviders, 'provider');
const domain = alias(authDomains, 'domain');
const attempt = alias(authFederationAttempts, 'attempt');
const providerSelection = {
  provider_id: provider.id,
  organization_id: provider.organizationId,
  control_workspace_id: authOrganizations.controlWorkspaceId,
  issuer: provider.issuer,
  kind: provider.kind,
  configuration: provider.configuration,
  sealed_secret: provider.sealedSecret,
  revision: provider.revision,
  enabled: provider.enabled,
  domain_id: domain.id,
  domain: domain.domain,
};
function providerQuery(client: PoolClient | Pool) {
  return drizzle(client)
    .select(providerSelection)
    .from(provider)
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, provider.organizationId),
    )
    .innerJoin(
      workspaces,
      eq(workspaces.id, authOrganizations.controlWorkspaceId),
    )
    .innerJoin(
      domain,
      and(
        eq(domain.organizationId, authOrganizations.id),
        isNotNull(domain.verifiedAt),
      ),
    );
}
type ProviderRecord = Awaited<ReturnType<typeof providerQuery>>[number];
// Provider writes validate the configuration for its kind before persisting it.
function providerHasKind<K extends ProviderRecord['kind']>(
  row: ProviderRecord,
  kind: K,
): row is ProviderRecord & {
  kind: K;
  configuration: K extends 'oidc' ? OidcConfiguration : SamlConfiguration;
} {
  return row.kind === kind;
}
function projectMaterial(row: ProviderRecord) {
  const shared = {
    id: row.provider_id,
    organizationId: row.organization_id,
    controlWorkspaceId: row.control_workspace_id,
    issuer: row.issuer,
    sealedSecret: row.sealed_secret,
    revision: row.revision,
    enabled: row.enabled,
  };
  if (providerHasKind(row, 'oidc'))
    return {
      domainId: row.domain_id,
      domain: row.domain,
      provider: { ...shared, kind: row.kind, configuration: row.configuration },
    };
  if (providerHasKind(row, 'saml'))
    return {
      domainId: row.domain_id,
      domain: row.domain,
      provider: { ...shared, kind: row.kind, configuration: row.configuration },
    };
  throw new Error('Unknown stored provider kind');
}
function attemptQuery(client: PoolClient | Pool) {
  return drizzle(client)
    .select({
      ...providerSelection,
      id: attempt.id,
      purpose: attempt.purpose,
      owner_user_id: attempt.ownerUserId,
      owner_session_id: attempt.ownerSessionId,
      return_path: attempt.returnPath,
      created_at: attempt.createdAt,
    })
    .from(attempt)
    .innerJoin(
      provider,
      and(
        eq(provider.id, attempt.providerId),
        eq(provider.organizationId, attempt.organizationId),
        eq(provider.revision, attempt.providerRevision),
      ),
    )
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, attempt.organizationId),
    )
    .innerJoin(
      workspaces,
      eq(workspaces.id, authOrganizations.controlWorkspaceId),
    )
    .innerJoin(
      domain,
      and(
        eq(domain.id, attempt.domainId),
        eq(domain.organizationId, attempt.organizationId),
        isNotNull(domain.verifiedAt),
      ),
    );
}
export async function findFederationAttempt(
  client: PoolClient | Pool,
  stateDigest: Buffer,
  browserDigest: Buffer,
  { locking = false }: Readonly<{ locking?: boolean | undefined }> = {},
): Promise<FederationAttempt | undefined> {
  const query = attemptQuery(client).where(
    and(
      eq(attempt.stateDigest, stateDigest),
      eq(attempt.browserDigest, browserDigest),
      isNull(attempt.consumedAt),
      gt(attempt.expiresAt, sql`clock_timestamp()`),
      inArray(workspaces.status, FEDERATION_WORKSPACE_STATUSES),
      or(eq(provider.enabled, true), eq(attempt.purpose, 'test')),
    ),
  );
  const [row] = await (
    locking ? query.for('update', { of: [attempt, provider, domain] }) : query
  ).catch(rethrowQueryFailure);
  if (row === undefined) return undefined;
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
export async function readFederationProvider(
  client: PoolClient | Pool,
  providerId: string,
  domainName: string,
  { testing = false }: Readonly<{ testing?: boolean | undefined }> = {},
) {
  const [row] = await providerQuery(client)
    .where(
      and(
        eq(provider.id, providerId),
        eq(domain.domain, domainName),
        inArray(workspaces.status, FEDERATION_WORKSPACE_STATUSES),
        or(eq(provider.enabled, true), sql`${testing}::boolean`),
      ),
    )
    .catch(rethrowQueryFailure);
  return row === undefined ? undefined : projectMaterial(row);
}
