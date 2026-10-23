import type { DelegatedRole } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import type {
  OrganizationRow,
  OrganizationSnapshot,
  ProviderRow,
  DomainRow,
} from './contract.js';

export async function projectOrganization(
  client: PoolClient,
  organization: OrganizationRow,
): Promise<OrganizationSnapshot> {
  const workspaces = await client.query<{
    workspace_id: string;
    name: string;
    default_role: DelegatedRole;
  }>(
    `select link.workspace_id,workspace.name,link.default_role from app.auth_organization_workspaces link
     join app.workspaces workspace on workspace.id=link.workspace_id where link.organization_id=$1 order by workspace.name,link.workspace_id`,
    [organization.id],
  );
  const domains = await client.query<DomainRow>(
    'select * from app.auth_domains where organization_id=$1 order by domain,id',
    [organization.id],
  );
  const providers = await client.query<ProviderRow>(
    'select * from app.auth_providers where organization_id=$1 order by name,id',
    [organization.id],
  );
  const checks = await client.query<{
    domain_id: string;
    provider_id: string;
    provider_revision: number;
    tested_at: Date;
  }>(
    'select domain_id,provider_id,provider_revision,tested_at from app.auth_provider_checks where organization_id=$1',
    [organization.id],
  );
  return {
    id: organization.id,
    name: organization.name,
    revision: organization.revision,
    controlWorkspaceId: organization.control_workspace_id,
    workspaces: workspaces.rows.map((row) => ({
      workspaceId: row.workspace_id,
      name: row.name,
      defaultRole: row.default_role,
    })),
    domains: domains.rows.map((row) => ({
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
      checks: checks.rows
        .filter((check) => check.domain_id === row.id)
        .map((check) => ({
          providerId: check.provider_id,
          providerRevision: check.provider_revision,
          testedAt: check.tested_at.toISOString(),
        })),
    })),
    providers: providers.rows.map((row) => {
      const common = {
        id: row.id,
        name: row.name,
        issuer: row.issuer,
        enabled: row.enabled,
        revision: row.revision,
      };
      return row.kind === 'oidc'
        ? {
            ...common,
            kind: row.kind,
            configuration: row.configuration,
            secretConfigured: row.sealed_secret !== null,
          }
        : { ...common, kind: row.kind, configuration: row.configuration };
    }),
  };
}
