import { authOrganizationWorkspaces } from '../../../schema/identity/federation/organizations.js';
import { workspaces } from '../../../schema/foundation.js';
import { authDomains } from '../../../schema/identity/federation/domains.js';
import {
  authProviders,
  authProviderChecks,
} from '../../../schema/identity/federation/providers.js';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { OidcConfiguration, SamlConfiguration } from '@pertexo/contracts';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import {
  domainRecords,
  providerRecords,
  type ProviderRecord,
} from './records.queries.js';

import type { PoolClient } from 'pg';
import type { OrganizationRow, OrganizationSnapshot } from './contract.js';

export async function projectOrganization(
  client: PoolClient,
  organization: OrganizationRow,
): Promise<OrganizationSnapshot> {
  const linkedWorkspaces = await drizzle(client)
    .select({
      workspace_id: authOrganizationWorkspaces.workspaceId,
      name: workspaces.name,
      default_role: authOrganizationWorkspaces.defaultRole,
    })
    .from(authOrganizationWorkspaces)
    .innerJoin(
      workspaces,
      eq(workspaces.id, authOrganizationWorkspaces.workspaceId),
    )
    .where(eq(authOrganizationWorkspaces.organizationId, organization.id))
    .orderBy(asc(workspaces.name), asc(authOrganizationWorkspaces.workspaceId))
    .catch(rethrowQueryFailure);
  const domains = await domainRecords(client)
    .where(eq(authDomains.organizationId, organization.id))
    .orderBy(asc(authDomains.domain), asc(authDomains.id))
    .catch(rethrowQueryFailure);
  const providers = await providerRecords(client)
    .where(eq(authProviders.organizationId, organization.id))
    .orderBy(asc(authProviders.name), asc(authProviders.id))
    .catch(rethrowQueryFailure);
  const checks = await drizzle(client)
    .select({
      domain_id: authProviderChecks.domainId,
      provider_id: authProviderChecks.providerId,
      provider_revision: authProviderChecks.providerRevision,
      tested_at: authProviderChecks.testedAt,
    })
    .from(authProviderChecks)
    .where(eq(authProviderChecks.organizationId, organization.id))
    .catch(rethrowQueryFailure);
  return {
    id: organization.id,
    name: organization.name,
    revision: organization.revision,
    controlWorkspaceId: organization.control_workspace_id,
    workspaces: linkedWorkspaces.map((row) => ({
      workspaceId: row.workspace_id,
      name: row.name,
      defaultRole: row.default_role,
    })),
    domains: domains.map((row) => ({
      id: row.id,
      domain: row.domain,
      revision: row.revision,
      verifiedAt: row.verified_at?.toISOString() ?? null,
      requireSso: row.require_sso,
      challenge:
        row.challenge !== null && row.challenge_expires_at !== null
          ? {
              recordName: `_pertexo.${row.domain}`,
              value: `pertexo-verification=${row.challenge}`,
              expiresAt: row.challenge_expires_at.toISOString(),
            }
          : null,
      checks: checks
        .filter((check) => check.domain_id === row.id)
        .map((check) => ({
          providerId: check.provider_id,
          providerRevision: check.provider_revision,
          testedAt: check.tested_at.toISOString(),
        })),
    })),
    providers: providers.map((row) => {
      const common = {
        id: row.id,
        name: row.name,
        issuer: row.issuer,
        enabled: row.enabled,
        revision: row.revision,
      };
      if (providerHasKind(row, 'oidc'))
        return {
          ...common,
          kind: row.kind,
          configuration: row.configuration,
          secretConfigured: row.sealed_secret !== null,
        };
      if (providerHasKind(row, 'saml'))
        return { ...common, kind: row.kind, configuration: row.configuration };
      throw new Error('Unknown stored provider kind');
    }),
  };
}

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
