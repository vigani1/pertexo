import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowPresenceLeases } from '../../schema/authoring/collaboration/presence.js';
import { workspaceMemberships, users } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { COLLABORATION_LIMITS } from '@pertexo/workflow-model';
import { rolesForCapability } from '@pertexo/workflow-model';
import type { WorkflowPresence } from '@pertexo/contracts';
import type { PoolClient } from 'pg';
import { requireCollaborationAuthority } from './authority.queries.js';
import { WorkflowCollaborationError } from './errors.js';
import type {
  CollaborationContext,
  CollaborationScope,
  WorkflowCollaborationStore,
} from './contract.js';
async function readPresence(
  client: PoolClient,
  input: CollaborationScope & { tabId: string },
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

export function collaborationPresence(
  context: CollaborationContext,
): Pick<WorkflowCollaborationStore, 'presence' | 'heartbeat' | 'leave'> {
  return {
    presence: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireCollaborationAuthority(client, input);
          return readPresence(client, input);
        },
        input.signal,
      ),
    heartbeat: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireCollaborationAuthority(client, input, 'update', {
            editing: input.editing,
          });
          return heartbeatPresence(client, input);
        },
        input.signal,
      ),
    leave: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireCollaborationAuthority(client, input);
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
        },
        input.signal,
      ),
  };
}

async function heartbeatPresence(
  client: PoolClient,
  input: Parameters<WorkflowCollaborationStore['heartbeat']>[0],
) {
  const db = drizzle(client),
    lease = workflowPresenceLeases;
  const scope = and(
    eq(lease.workspaceId, input.workspaceId),
    eq(lease.workflowId, input.workflowId),
  );
  const own = and(
    scope,
    eq(lease.userId, input.actorId),
    eq(lease.tabId, input.tabId),
  );
  await db
    .delete(lease)
    .where(and(scope, lte(lease.expiresAt, sql`clock_timestamp()`)))
    .catch(rethrowQueryFailure);
  const existing = await db
    .select({ sequence: lease.sequence })
    .from(lease)
    .where(own)
    .catch(rethrowQueryFailure);
  if (existing.length === 0) {
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::integer`,
        own: sql<number>`count(*) filter(where ${lease.userId}=${input.actorId})::integer`,
      })
      .from(lease)
      .where(scope)
      .catch(rethrowQueryFailure);
    if (counts === undefined) throw new Error('Presence counts missing');
    if (
      counts.total >= COLLABORATION_LIMITS.presence ||
      counts.own >= COLLABORATION_LIMITS.tabs
    )
      throw new WorkflowCollaborationError(
        'limit',
        'Presence is full for this workflow. You can still edit and save normally.',
      );
  }
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
      expiresAt: sql`clock_timestamp()+${COLLABORATION_LIMITS.leaseSeconds}*interval '1 second'`,
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
  return { accepted: stored.rowCount === 1 };
}
