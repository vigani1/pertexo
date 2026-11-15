import { SECOND_INTERVAL } from '../../shared/sql-intervals.repository.js';
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowPresenceLeases,
  workspaceMemberships,
  users,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { COLLABORATION_LIMITS } from '@pertexo/workflow-model';
import { rolesForCapability } from '@pertexo/policy';
import type { WorkflowPresence } from '@pertexo/contracts';
import type { PoolClient } from 'pg';
import type {
  HeartbeatInput,
  PresenceInput,
} from './workflow-collaboration.types.js';
export async function readPresence(
  client: PoolClient,
  input: PresenceInput,
): Promise<WorkflowPresence> {
  const lease = workflowPresenceLeases,
    member = workspaceMemberships;
  const editor = inArray(member.role, rolesForCapability('workflow:update'));
  const editing = sql<boolean>`bool_or(${lease.editing} and ${editor})`,
    dirty = sql<boolean>`bool_or(${lease.dirty} and ${editor})`;
  const people = await drizzle(client)
    .select({
      userId: lease.userId,
      displayName: users.displayName,
      editing,
      dirty,
      baseRevision: sql<number | null>`min(${lease.baseRevision})`,
      tabCount: sql<number>`count(*)::integer`,
    })
    .from(lease)
    .innerJoin(
      member,
      and(
        eq(member.workspaceId, lease.workspaceId),
        eq(member.userId, lease.userId),
        eq(member.status, 'active'),
      ),
    )
    .innerJoin(
      users,
      and(eq(users.id, member.userId), eq(users.status, 'active')),
    )
    .where(
      and(
        eq(lease.workspaceId, input.workspaceId),
        eq(lease.workflowId, input.workflowId),
        gt(lease.expiresAt, sql`clock_timestamp()`),
        sql`not(${lease.userId}=${input.actorId} and ${lease.tabId}=${input.tabId})`,
      ),
    )
    .groupBy(lease.userId, users.displayName)
    .orderBy(
      desc(dirty),
      desc(editing),
      asc(users.displayName),
      asc(lease.userId),
    )
    .limit(COLLABORATION_LIMITS.presence)
    .catch(rethrowQueryFailure);
  return { people };
}

function presenceScopes(input: HeartbeatInput) {
  const lease = workflowPresenceLeases;
  const scope = and(
    eq(lease.workspaceId, input.workspaceId),
    eq(lease.workflowId, input.workflowId),
  );
  const own = and(
    scope,
    eq(lease.userId, input.actorId),
    eq(lease.tabId, input.tabId),
  );
  return { scope, own };
}

/** Drops the workflow's expired presence leases. */
export async function pruneExpiredPresence(
  client: PoolClient,
  input: HeartbeatInput,
) {
  const lease = workflowPresenceLeases;
  const { scope } = presenceScopes(input);
  await drizzle(client)
    .delete(lease)
    .where(and(scope, lte(lease.expiresAt, sql`clock_timestamp()`)))
    .catch(rethrowQueryFailure);
}

/** Whether this tab already holds a lease. */
export async function holdsPresence(client: PoolClient, input: HeartbeatInput) {
  const lease = workflowPresenceLeases;
  const { own } = presenceScopes(input);
  const existing = await drizzle(client)
    .select({ sequence: lease.sequence })
    .from(lease)
    .where(own)
    .catch(rethrowQueryFailure);
  return existing.length > 0;
}

/** The workflow's leases, all and this person's. */
export async function countPresence(client: PoolClient, input: HeartbeatInput) {
  const lease = workflowPresenceLeases;
  const { scope } = presenceScopes(input);
  const [counts] = await drizzle(client)
    .select({
      total: sql<number>`count(*)::integer`,
      own: sql<number>`count(*) filter(where ${lease.userId}=${input.actorId})::integer`,
    })
    .from(lease)
    .where(scope)
    .catch(rethrowQueryFailure);
  return counts;
}

/** Stores the heartbeat unless a later one already did; true when it was stored. */
export async function storePresence(client: PoolClient, input: HeartbeatInput) {
  const db = drizzle(client),
    lease = workflowPresenceLeases;
  const stored = await db
    .insert(lease)
    .values({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      userId: input.actorId,
      tabId: input.tabId,
      sequence: input.sequence,
      editing: input.editing,
      dirty: input.dirty,
      baseRevision: input.baseRevision,
      lastSeenAt: sql`clock_timestamp()`,
      expiresAt: sql`clock_timestamp()+${COLLABORATION_LIMITS.leaseSeconds}*${SECOND_INTERVAL}`,
    })
    .onConflictDoUpdate({
      target: [lease.workspaceId, lease.workflowId, lease.userId, lease.tabId],
      set: {
        sequence: sql`excluded.sequence`,
        editing: sql`excluded.editing`,
        dirty: sql`excluded.dirty`,
        baseRevision: sql`excluded.base_revision`,
        lastSeenAt: sql`excluded.last_seen_at`,
        expiresAt: sql`excluded.expires_at`,
      },
      setWhere: sql`${lease.sequence}<excluded.sequence`,
    })
    .catch(rethrowQueryFailure);
  return stored.rowCount === 1;
}

/** Ends this tab's presence. */
export async function leavePresence(client: PoolClient, input: PresenceInput) {
  await drizzle(client)
    .delete(workflowPresenceLeases)
    .where(
      and(
        eq(workflowPresenceLeases.workspaceId, input.workspaceId),
        eq(workflowPresenceLeases.workflowId, input.workflowId),
        eq(workflowPresenceLeases.userId, input.actorId),
        eq(workflowPresenceLeases.tabId, input.tabId),
      ),
    )
    .catch(rethrowQueryFailure);
}
