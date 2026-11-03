import { and, asc, eq, exists, inArray, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  authAccounts,
  authDomains,
  authOrganizations,
  authProviders,
  users,
  workspaceMemberships,
  workspaces,
} from '@pertexo/database/schema';
import { withActorDiscoveryScope } from '@pertexo/database/primitives';
import { canonicalEmailDomainSql } from '../../canonical-email.js';
import { canCreateAuthenticationSession } from './authority.repository.js';

/**
 * Method removal is global account work, not a workspace command. Match identity
 * writers' workspace -> organization -> user order; never acquire these locks
 * after the caller has locked the user. Re-discover after locking because the
 * address, linked providers or recovery ownership may have changed while waiting.
 */
export async function lockSignInMethodAuthority(
  client: PoolClient,
  userId: string,
): Promise<boolean> {
  const organizations = await methodOrganizations(client, userId);
  const db = drizzle(client);
  const workspaceIds = [
    ...new Set(organizations.map((row) => row.workspaceId)),
  ].sort();
  for (const id of workspaceIds)
    await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .for('share');
  for (const organization of organizations)
    await db
      .select({ id: authOrganizations.id })
      .from(authOrganizations)
      .where(eq(authOrganizations.id, organization.id))
      .for('share');
  const [user] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (user?.status !== 'active') return false;
  const current = await methodOrganizations(client, userId);
  return (
    current.length === organizations.length &&
    current.every(
      (row, index) =>
        row.id === organizations[index]?.id &&
        row.workspaceId === organizations[index].workspaceId,
    )
  );
}

/** The organization lock fences policy, provider and directory changes together. */
export async function hasUsableSignInMethod(
  client: PoolClient,
  userId: string,
  accounts: readonly (typeof authAccounts.$inferSelect)[],
  available: Readonly<{
    socialProviders: readonly string[];
    organizationProtocols: readonly ('oidc' | 'saml')[];
  }>,
): Promise<boolean> {
  for (const account of accounts) {
    if (account.providerId === 'credential') {
      if (
        account.password !== null &&
        account.password.length > 0 &&
        (await canCreateAuthenticationSession(client, userId, {
          method: 'credential',
        }))
      )
        return true;
    } else if (available.socialProviders.includes(account.providerId)) {
      if (
        await canCreateAuthenticationSession(client, userId, {
          method: 'social',
        })
      )
        return true;
    } else {
      const [provider] = await drizzle(client)
        .select({
          id: authProviders.id,
          kind: authProviders.kind,
          revision: authProviders.revision,
        })
        .from(authProviders)
        .where(sql`${authProviders.id}::text=${account.providerId}`);
      if (
        provider !== undefined &&
        available.organizationProtocols.includes(provider.kind) &&
        (await canCreateAuthenticationSession(client, userId, {
          method: 'organization',
          providerId: provider.id,
          providerRevision: provider.revision,
        }))
      )
        return true;
    }
  }
  return false;
}

function methodOrganizations(client: PoolClient, userId: string) {
  return withActorDiscoveryScope(client, userId, async (scoped) => {
    const db = drizzle(scoped);
    const domain = db
      .select({ id: authDomains.organizationId })
      .from(authDomains)
      .innerJoin(
        users,
        eq(authDomains.domain, canonicalEmailDomainSql(users.email)),
      )
      .where(eq(users.id, userId));
    const providers = db
      .select({ id: authProviders.organizationId })
      .from(authProviders)
      .innerJoin(
        authAccounts,
        sql`${authProviders.id}::text=${authAccounts.providerId}`,
      )
      .where(eq(authAccounts.userId, userId));
    const ownership = db
      .select({ one: sql`1` })
      .from(workspaceMemberships)
      .where(
        and(
          eq(
            workspaceMemberships.workspaceId,
            authOrganizations.controlWorkspaceId,
          ),
          eq(workspaceMemberships.userId, userId),
          eq(workspaceMemberships.role, 'owner'),
          eq(workspaceMemberships.status, 'active'),
        ),
      );
    return db
      .select({
        id: authOrganizations.id,
        workspaceId: authOrganizations.controlWorkspaceId,
      })
      .from(authOrganizations)
      .where(
        or(
          inArray(authOrganizations.id, domain),
          inArray(authOrganizations.id, providers),
          exists(ownership),
        ),
      )
      .orderBy(asc(authOrganizations.id));
  });
}
