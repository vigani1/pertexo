import {
  systemMailDeliveries,
  noticeMailBatches,
  authFederationAttempts,
  authOrganizations,
  authSessions,
  authAccounts,
  authProviders,
} from '@pertexo/database/schema';
import { asc, eq, exists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export async function purgeNoticeMail(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db
    .$with('page')
    .as(
      db
        .select({ id: systemMailDeliveries.id })
        .from(systemMailDeliveries)
        .innerJoin(
          noticeMailBatches,
          eq(noticeMailBatches.id, systemMailDeliveries.id),
        )
        .where(eq(noticeMailBatches.workspaceId, workspaceId))
        .limit(pageSize),
    );
  return (
    await db
      .with(page)
      .delete(systemMailDeliveries)
      .where(
        exists(
          db
            .select({ one: sql`1` })
            .from(page)
            .where(eq(page.id, systemMailDeliveries.id)),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function purgeFederationAttempts(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db
    .$with('page')
    .as(
      db
        .select({ id: authFederationAttempts.id })
        .from(authFederationAttempts)
        .innerJoin(
          authOrganizations,
          eq(authOrganizations.id, authFederationAttempts.organizationId),
        )
        .where(eq(authOrganizations.controlWorkspaceId, workspaceId))
        .orderBy(asc(authFederationAttempts.id))
        .limit(pageSize),
    );
  return (
    await db
      .with(page)
      .delete(authFederationAttempts)
      .where(
        exists(
          db
            .select({ one: sql`1` })
            .from(page)
            .where(eq(page.id, authFederationAttempts.id)),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function purgeProviderSessions(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db
    .$with('page')
    .as(
      db
        .select({ id: authSessions.id })
        .from(authSessions)
        .innerJoin(
          authProviders,
          eq(authProviders.id, authSessions.federationProviderId),
        )
        .innerJoin(
          authOrganizations,
          eq(authOrganizations.id, authProviders.organizationId),
        )
        .where(eq(authOrganizations.controlWorkspaceId, workspaceId))
        .orderBy(asc(authSessions.id))
        .limit(pageSize),
    );
  return (
    await db
      .with(page)
      .delete(authSessions)
      .where(
        exists(
          db
            .select({ one: sql`1` })
            .from(page)
            .where(eq(page.id, authSessions.id)),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function purgeProviderAccounts(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .innerJoin(
        authProviders,
        sql`${authProviders.id}::text=${authAccounts.providerId}`,
      )
      .innerJoin(
        authOrganizations,
        eq(authOrganizations.id, authProviders.organizationId),
      )
      .where(eq(authOrganizations.controlWorkspaceId, workspaceId))
      .orderBy(asc(authAccounts.id))
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .delete(authAccounts)
      .where(
        exists(
          db
            .select({ one: sql`1` })
            .from(page)
            .where(eq(page.id, authAccounts.id)),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function purgeOrganization(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db
    .$with('page')
    .as(
      db
        .select({ id: authOrganizations.id })
        .from(authOrganizations)
        .where(eq(authOrganizations.controlWorkspaceId, workspaceId))
        .limit(pageSize),
    );
  return (
    await db
      .with(page)
      .delete(authOrganizations)
      .where(
        exists(
          db
            .select({ one: sql`1` })
            .from(page)
            .where(eq(page.id, authOrganizations.id)),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
