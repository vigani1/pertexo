import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { authOrganizations } from '../../../schema/identity/federation/organizations.js';
import { authDomains } from '../../../schema/identity/federation/domains.js';
import { authProviders } from '../../../schema/identity/federation/providers.js';
export const organizationSelection = {
  id: authOrganizations.id,
  control_workspace_id: authOrganizations.controlWorkspaceId,
  name: authOrganizations.name,
  revision: authOrganizations.revision,
};
export function organizationRecords(client: PoolClient) {
  return drizzle(client).select(organizationSelection).from(authOrganizations);
}
export type OrganizationRecord = Awaited<
  ReturnType<typeof organizationRecords>
>[number];
export function domainRecords(client: PoolClient) {
  return drizzle(client)
    .select({
      id: authDomains.id,
      organization_id: authDomains.organizationId,
      domain: authDomains.domain,
      challenge: authDomains.challenge,
      challenge_expires_at: authDomains.challengeExpiresAt,
      verified_at: authDomains.verifiedAt,
      require_sso: authDomains.requireSso,
      revision: authDomains.revision,
    })
    .from(authDomains);
}
export type DomainRecord = Awaited<ReturnType<typeof domainRecords>>[number];
export function providerRecords(client: PoolClient) {
  return drizzle(client)
    .select({
      id: authProviders.id,
      organization_id: authProviders.organizationId,
      name: authProviders.name,
      issuer: authProviders.issuer,
      kind: authProviders.kind,
      configuration: authProviders.configuration,
      sealed_secret: authProviders.sealedSecret,
      enabled: authProviders.enabled,
      revision: authProviders.revision,
    })
    .from(authProviders);
}
export type ProviderRecord = Awaited<
  ReturnType<typeof providerRecords>
>[number];
