import { workspaceMemberships, users } from '../../../schema/foundation.js';
import { authAccounts, authSessions } from '../../../schema/authentication.js';
import {
  authProviderChecks,
  authProviders,
} from '../../../schema/identity/federation/providers.js';
import { authDomains } from '../../../schema/identity/federation/domains.js';
import { and, eq, inArray, isNotNull, ne, notExists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { FederationConflictError } from './errors.js';
import { recordFederationAudit } from './authority.repository.js';
import {
  advanceOrganization,
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
} from './commands.repository.js';
import type { FederationCommand } from './contract.js';
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
        await drizzle(scoped)
          .select({ user_id: workspaceMemberships.userId })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, controlWorkspaceId),
              eq(workspaceMemberships.role, 'owner'),
              eq(workspaceMemberships.status, 'active'),
            ),
          )
          .catch(rethrowQueryFailure)
      )[0],
  );
  const credential =
    owner === undefined
      ? []
      : await drizzle(client)
          .select({ id: users.id })
          .from(users)
          .innerJoin(
            authAccounts,
            and(
              eq(authAccounts.userId, users.id),
              eq(authAccounts.providerId, 'credential'),
            ),
          )
          .where(
            and(
              eq(users.id, owner.user_id),
              eq(users.status, 'active'),
              eq(users.emailVerified, true),
              isNotNull(authAccounts.password),
              sql`length(${authAccounts.password})>0`,
            ),
          )
          .catch(rethrowQueryFailure);
  if (owner === undefined || credential.length !== 1)
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
  const db = drizzle(client);
  const checked = db
    .select({ one: sql`1` })
    .from(authProviderChecks)
    .innerJoin(
      authProviders,
      and(
        eq(authProviders.id, authProviderChecks.providerId),
        eq(authProviders.organizationId, authProviderChecks.organizationId),
      ),
    )
    .where(
      and(
        eq(authProviderChecks.domainId, authDomains.id),
        eq(authProviderChecks.organizationId, authDomains.organizationId),
        eq(authProviders.enabled, true),
        eq(authProviderChecks.providerRevision, authProviders.revision),
        excludingProviderId === undefined
          ? undefined
          : ne(authProviders.id, excludingProviderId),
      ),
    );
  const missing = await db
    .select({ id: authDomains.id })
    .from(authDomains)
    .where(
      and(
        eq(authDomains.organizationId, organizationId),
        eq(authDomains.requireSso, true),
        notExists(checked),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  if (missing.length !== 0)
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
        const ready = await drizzle(client)
          .select({ one: sql`1` })
          .from(authProviderChecks)
          .innerJoin(
            authProviders,
            and(
              eq(authProviders.id, authProviderChecks.providerId),
              eq(
                authProviders.organizationId,
                authProviderChecks.organizationId,
              ),
            ),
          )
          .where(
            and(
              eq(authProviderChecks.domainId, domain.id),
              eq(authProviderChecks.organizationId, organization.id),
              eq(authProviders.enabled, true),
              eq(authProviderChecks.providerRevision, authProviders.revision),
            ),
          )
          .limit(1)
          .catch(rethrowQueryFailure);
        if (ready.length !== 1)
          throw new FederationConflictError(
            'provider_untested',
            'Complete a test sign-in with an enabled provider for this domain first.',
          );
      }
      if (domain.require_sso !== input.required) {
        await drizzle(client)
          .update(authDomains)
          .set({
            requireSso: input.required,
            revision: sql`${authDomains.revision}+1`,
          })
          .where(eq(authDomains.id, domain.id))
          .catch(rethrowQueryFailure);
        const affected = drizzle(client)
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(split_part(${users.email},'@',2))=${domain.domain}`);
        await drizzle(client)
          .delete(authSessions)
          .where(inArray(authSessions.userId, affected))
          .catch(rethrowQueryFailure);
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
