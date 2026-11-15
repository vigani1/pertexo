import { canonicalEmailDomainSql } from '../../canonical-email.repository.js';
import {
  workspaceMemberships,
  users,
  authAccounts,
  authSessions,
  authProviderChecks,
  authProviders,
  authDomains,
} from '@pertexo/database/schema';
import { and, eq, inArray, isNotNull, ne, notExists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

/** The control workspace's active owner, if it has one. */
export async function readControlOwner(
  client: PoolClient,
  controlWorkspaceId: string,
): Promise<Readonly<{ user_id: string }> | undefined> {
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
  return owner;
}

/** Whether the owner is active and verified with a working password. */
export async function ownerHasRecoveryCredential(
  client: PoolClient,
  ownerUserId: string,
): Promise<boolean> {
  const credential = await drizzle(client)
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
        eq(users.id, ownerUserId),
        eq(users.status, 'active'),
        eq(users.emailVerified, true),
        isNotNull(authAccounts.password),
        sql`length(${authAccounts.password})>0`,
      ),
    )
    .catch(rethrowQueryFailure);
  return credential.length === 1;
}

/** Whether some required domain has no tested enabled provider left (optionally without one provider). */
export async function hasUntestedRequiredDomain(
  client: PoolClient,
  organizationId: string,
  excludingProviderId?: string,
): Promise<boolean> {
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
  return missing.length !== 0;
}

/** Whether an enabled provider passed a test for this domain at its current revision. */
export async function domainHasTestedProvider(
  client: PoolClient,
  organizationId: string,
  domainId: string,
): Promise<boolean> {
  const ready = await drizzle(client)
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
        eq(authProviderChecks.domainId, domainId),
        eq(authProviderChecks.organizationId, organizationId),
        eq(authProviders.enabled, true),
        eq(authProviderChecks.providerRevision, authProviders.revision),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return ready.length === 1;
}

/** Sets the requirement and signs out everyone whose email is on the domain. */
export async function setDomainRequirement(
  client: PoolClient,
  domain: Readonly<{ id: string; domain: string }>,
  required: boolean,
): Promise<void> {
  await drizzle(client)
    .update(authDomains)
    .set({
      requireSso: required,
      revision: sql`${authDomains.revision}+1`,
    })
    .where(eq(authDomains.id, domain.id))
    .catch(rethrowQueryFailure);
  const affected = drizzle(client)
    .select({ id: users.id })
    .from(users)
    .where(sql`${canonicalEmailDomainSql(users.email)}=${domain.domain}`);
  await drizzle(client)
    .delete(authSessions)
    .where(inArray(authSessions.userId, affected))
    .catch(rethrowQueryFailure);
}
