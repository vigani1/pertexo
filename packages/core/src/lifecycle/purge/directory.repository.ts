import {
  authOrganizationWorkspaces,
  authOrganizations,
  workspaces,
  authDirectoryMemberships,
} from '@pertexo/database/schema';
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { detachDirectoryMemberships } from '../../identity/federation/provisioning/management/detach.repository.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { scopeToWorkspace } from '../retention/transaction.js';

/** How many due workspaces one claim tries before reporting nothing to do. */
const PURGE_CLAIM_CANDIDATES = 10;

async function linkedWorkspaceIds(
  client: PoolClient,
  workspaceId: string,
): Promise<string[]> {
  const db = drizzle(client),
    source = alias(authOrganizationWorkspaces, 'source');
  const organizations = db
    .select({ organizationId: source.organizationId })
    .from(source)
    .where(eq(source.workspaceId, workspaceId));
  const rows = await db
    .select({ workspaceId: authOrganizationWorkspaces.workspaceId })
    .from(authOrganizationWorkspaces)
    .where(inArray(authOrganizationWorkspaces.organizationId, organizations))
    .catch(rethrowQueryFailure);
  return [
    ...new Set([workspaceId, ...rows.map((row) => row.workspaceId)]),
  ].sort();
}
function purgeIsDue() {
  return or(
    and(
      eq(workspaces.status, 'pending_deletion'),
      lte(workspaces.purgeAfter, sql`clock_timestamp()`),
    ),
    eq(workspaces.status, 'purging'),
  );
}

/** Directory fan-out keeps the same sorted workspace-first lock plan as sign-in. */
export async function claimPurgeWorkspace(
  client: PoolClient,
): Promise<
  Readonly<{ id: string; status: 'pending_deletion' | 'purging' }> | undefined
> {
  const db = drizzle(client);
  const candidates = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(purgeIsDue())
    .orderBy(asc(workspaces.purgeAfter), asc(workspaces.id))
    .limit(PURGE_CLAIM_CANDIDATES)
    .catch(rethrowQueryFailure);
  for (const candidate of candidates) {
    const plan = await linkedWorkspaceIds(client, candidate.id);
    const locked = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.id, plan))
      .orderBy(asc(workspaces.id))
      .for('update', { skipLocked: true })
      .catch(rethrowQueryFailure);
    if (locked.length !== plan.length) continue;
    const current = await linkedWorkspaceIds(client, candidate.id);
    const samePlan =
      current.length === plan.length &&
      current.every((id, index) => id === plan[index]);
    if (!samePlan) continue;
    const [row] = await db
      .select({
        id: workspaces.id,
        status: sql<'pending_deletion' | 'purging'>`${workspaces.status}`,
      })
      .from(workspaces)
      .where(and(eq(workspaces.id, candidate.id), purgeIsDue()))
      .catch(rethrowQueryFailure);
    if (row !== undefined) return row;
  }
  return undefined;
}

/** One source page may include other workspaces when their control organization is purged. */
export async function purgeDirectoryMemberships(
  client: PoolClient,
  workspaceId: string,
  limit: number,
): Promise<number> {
  const db = drizzle(client);
  const [source] = await db
    .select({
      organizationId: authDirectoryMemberships.organizationId,
      workspaceId: authDirectoryMemberships.workspaceId,
    })
    .from(authDirectoryMemberships)
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, authDirectoryMemberships.organizationId),
    )
    .where(
      or(
        eq(authDirectoryMemberships.workspaceId, workspaceId),
        eq(authOrganizations.controlWorkspaceId, workspaceId),
      ),
    )
    .orderBy(
      asc(authDirectoryMemberships.workspaceId),
      asc(authDirectoryMemberships.userId),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  if (source === undefined) return 0;
  await db
    .execute(sql`select set_config('app.workspace_id','',true)`)
    .catch(rethrowQueryFailure);
  const changed = await detachDirectoryMemberships(
    client,
    source.organizationId,
    { workspaceId: source.workspaceId, limit },
  );
  await scopeToWorkspace(client, workspaceId);
  return changed;
}
