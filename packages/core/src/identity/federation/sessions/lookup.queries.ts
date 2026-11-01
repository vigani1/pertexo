import {
  authSessions,
  authAccounts,
  users,
  workspaceMemberships,
  workspaces,
  authDomains,
  authOrganizations,
  authProviders,
  authDirectoryUsers,
} from '@pertexo/database/schema';
import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool, PoolClient } from 'pg';
import {
  accountPolicy,
  authenticationAllowed,
  FEDERATION_WORKSPACE_STATUSES,
  sessionProof,
} from './policy.js';

function scopedSession(db: NodePgDatabase, sessionId: string) {
  const source = db
    .select({
      user_id: authSessions.userId,
      authentication_method: authSessions.authenticationMethod,
      federation_provider_id: authSessions.federationProviderId,
      federation_provider_revision: authSessions.federationProviderRevision,
      status: users.status,
      email_verified: users.emailVerified,
      organization_id: authDomains.organizationId,
      require_sso: authDomains.requireSso,
      workspace_scope:
        sql<string>`set_config('app.workspace_id',coalesce(${authOrganizations.controlWorkspaceId}::text,''),true)`.as(
          'workspace_scope',
        ),
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .leftJoin(
      authDomains,
      and(
        sql`${authDomains.domain}=lower(split_part(${users.email},'@',2))`,
        isNotNull(authDomains.verifiedAt),
      ),
    )
    .leftJoin(
      authOrganizations,
      eq(authOrganizations.id, authDomains.organizationId),
    )
    .where(
      and(
        eq(authSessions.id, sessionId),
        gt(authSessions.expiresAt, sql`clock_timestamp()`),
      ),
    );
  return { source, scoped: db.$with('scoped_session').as(source) };
}
type ScopedSession = ReturnType<typeof scopedSession>['scoped'];
function recoveryFacts(db: NodePgDatabase, scoped: ScopedSession) {
  const ownership = db
    .select({ one: sql`1` })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(
          workspaceMemberships.workspaceId,
          sql`nullif(${scoped.workspace_scope},'')::uuid`,
        ),
        eq(workspaceMemberships.userId, scoped.user_id),
        eq(workspaceMemberships.role, 'owner'),
        eq(workspaceMemberships.status, 'active'),
      ),
    );
  const password = db
    .select({ present: sql<boolean>`count(*)=1` })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.userId, scoped.user_id),
        eq(authAccounts.providerId, 'credential'),
        isNotNull(authAccounts.password),
        sql`length(${authAccounts.password})>0`,
      ),
    );
  return { ownership, password };
}
function providerFacts(db: NodePgDatabase, scoped: ScopedSession) {
  const provider = db
    .select({
      organization_id: authProviders.organizationId,
      enabled: authProviders.enabled,
      revision: authProviders.revision,
    })
    .from(authProviders)
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, authProviders.organizationId),
    )
    .innerJoin(
      workspaces,
      eq(workspaces.id, authOrganizations.controlWorkspaceId),
    )
    .where(
      and(
        eq(authProviders.id, scoped.federation_provider_id),
        inArray(workspaces.status, FEDERATION_WORKSPACE_STATUSES),
      ),
    )
    .as('provider');
  const directory = db
    .select({
      active: authDirectoryUsers.active,
      deleted_at: authDirectoryUsers.deletedAt,
    })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(authDirectoryUsers.organizationId, provider.organization_id),
        eq(authDirectoryUsers.userId, scoped.user_id),
      ),
    )
    .orderBy(
      desc(isNull(authDirectoryUsers.deletedAt)),
      desc(authDirectoryUsers.createdAt),
      desc(authDirectoryUsers.id),
    )
    .limit(1)
    .as('directory');
  return { provider, directory };
}
function sessionFactsQuery(pool: Pool | PoolClient, sessionId: string) {
  const db = drizzle(pool);
  const { scoped, source: scope } = scopedSession(db, sessionId);
  const { ownership, password } = recoveryFacts(db, scoped);
  const { provider, directory } = providerFacts(db, scoped);
  const query = db
    .select({
      user_id: scoped.user_id,
      authentication_method: scoped.authentication_method,
      federation_provider_id: scoped.federation_provider_id,
      federation_provider_revision: scoped.federation_provider_revision,
      status: scoped.status,
      email_verified: scoped.email_verified,
      organization_id: scoped.organization_id,
      require_sso: scoped.require_sso,
      control_owner: sql<boolean>`${exists(ownership)}`.as('control_owner'),
      password_present: sql<boolean>`(${password})`.as('password_present'),
      provider_organization_id: sql<
        string | null
      >`${provider.organization_id}`.as('provider_organization_id'),
      provider_enabled: sql<boolean | null>`${provider.enabled}`.as(
        'provider_enabled',
      ),
      provider_revision: sql<number | null>`${provider.revision}`.as(
        'provider_revision',
      ),
      directory_allowed:
        sql<boolean>`coalesce(${directory.active} and ${directory.deleted_at} is null,true)`.as(
          'directory_allowed',
        ),
    })
    .from(scoped)
    .leftJoinLateral(provider, sql`true`)
    .leftJoinLateral(directory, sql`true`);
  return { query, scope };
}

/** The materialized scope precedes RLS reads and expires with this single statement. */
export async function isAuthenticationSessionAllowed(
  pool: Pool | PoolClient,
  sessionId: string,
): Promise<boolean> {
  const { query, scope } = sessionFactsQuery(pool, sessionId);
  // Drizzle cannot mark a CTE MATERIALIZED; the scope fence must run before RLS reads.
  const result = await drizzle(pool)
    .execute<Awaited<typeof query>[number]>(
      sql`with scoped_session as materialized (${scope}) ${query}`,
    )
    .catch(rethrowQueryFailure);
  const facts = result.rows[0];
  if (facts === undefined) return false;
  return authenticationAllowed(
    accountPolicy(facts),
    sessionProof(facts),
    facts.provider_organization_id === null || facts.provider_revision === null
      ? undefined
      : {
          organizationId: facts.provider_organization_id,
          enabled: facts.provider_enabled ?? false,
          revision: facts.provider_revision,
          directoryAllowed: facts.directory_allowed,
        },
  );
}
