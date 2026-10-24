import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { FederationConflictError } from './contract.js';
import { recordFederationAudit } from './authority.repository.js';
import {
  advanceOrganization,
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
  type FederationCommand,
} from './commands.repository.js';
import { requireOrganizationDomain } from './domains.repository.js';

async function requireRecoveryCredential(
  client: PoolClient,
  controlWorkspaceId: string,
): Promise<string> {
  const owner = await withWorkspaceScope(
    client,
    { workspaceId: controlWorkspaceId },
    async (scoped) =>
      (
        await scoped.query<{ user_id: string }>(
          "select user_id from app.workspace_memberships where workspace_id=$1 and role='owner' and status='active'",
          [controlWorkspaceId],
        )
      ).rows[0],
  );
  if (
    owner === undefined ||
    (
      await client.query(
        "select users.id from app.users users join app.auth_accounts account on account.user_id=users.id and account.provider_id='credential' where users.id=$1 and users.status='active' and users.email_verified and account.password is not null and length(account.password)>0",
        [owner.user_id],
      )
    ).rowCount !== 1
  )
    throw new FederationConflictError(
      'recovery_required',
      'The control workspace owner needs a verified account with a working password before SSO can be required.',
    );
  return owner.user_id;
}
/** A policy must retain a successfully tested enabled provider for every required domain. */
export async function assertRequiredDomainsReady(
  client: PoolClient,
  organizationId: string,
  excludingProviderId?: string,
): Promise<void> {
  const missing = await client.query(
    `select domain.id from app.auth_domains domain where domain.organization_id=$1 and domain.require_sso and not exists(
 select 1 from app.auth_provider_checks checked join app.auth_providers provider on provider.id=checked.provider_id and provider.organization_id=checked.organization_id
 where checked.domain_id=domain.id and checked.organization_id=domain.organization_id and provider.enabled and checked.provider_revision=provider.revision and ($2::uuid is null or provider.id<>$2)) limit 1`,
    [organizationId, excludingProviderId ?? null],
  );
  if (missing.rowCount !== 0)
    throw new FederationConflictError(
      'provider_untested',
      'Turn off required SSO or test another enabled provider before changing this provider.',
    );
}
export function configureDomainEnforcement(
  pool: Pool,
  input: FederationCommand & Readonly<{ domainId: string; required: boolean }>,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.domain.enforcement',
    request: {
      domainId: input.domainId,
      required: input.required,
      expectedRevision: input.expectedRevision,
    },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      const domain = await requireOrganizationDomain(
        client,
        organization.id,
        input.domainId,
      );
      if (input.required) {
        if (domain.verified_at === null)
          throw new FederationConflictError(
            'dns_unverified',
            'Verify the domain DNS record before requiring SSO.',
          );
        await requireRecoveryCredential(
          client,
          organization.control_workspace_id,
        );
        const ready = await client.query(
          `select 1 from app.auth_provider_checks checked join app.auth_providers provider on provider.id=checked.provider_id and provider.organization_id=checked.organization_id
    where checked.domain_id=$1 and checked.organization_id=$2 and provider.enabled and checked.provider_revision=provider.revision limit 1`,
          [domain.id, organization.id],
        );
        if (ready.rowCount !== 1)
          throw new FederationConflictError(
            'provider_untested',
            'Complete a test sign-in with an enabled provider for this domain first.',
          );
      }
      if (domain.require_sso !== input.required) {
        await client.query(
          'update app.auth_domains set require_sso=$2,revision=revision+1 where id=$1',
          [domain.id, input.required],
        );
        await client.query(
          "delete from app.auth_sessions session using app.users users where session.user_id=users.id and lower(split_part(users.email,'@',2))=$1",
          [domain.domain],
        );
        await recordFederationAudit(client, input, {
          action: 'identity.domain_enforcement_changed',
          targetId: organization.id,
          metadata: { domainId: domain.id, required: input.required },
        });
        return advanceOrganization(client, organization);
      }
      return organization;
    },
  });
}
