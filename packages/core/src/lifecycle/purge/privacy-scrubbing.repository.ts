import {
  auditEvents,
  usageEvents,
  transportSecurityAuditFacts,
} from '@pertexo/database/schema';
import { and, eq, isNotNull, ne, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export async function scrubAuditFacts(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({ ctid: sql<string>`${auditEvents}.ctid`.as('purge_ctid') })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, workspaceId),
          or(
            isNotNull(auditEvents.actorUserId),
            isNotNull(auditEvents.requestId),
            isNotNull(auditEvents.traceId),
            sql`${auditEvents.metadata}<>'{}'::jsonb`,
            sql`${auditEvents.targetId} is distinct from ${workspaceId}::uuid`,
          ),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .update(auditEvents)
      .set({
        actorUserId: null,
        requestId: null,
        traceId: null,
        metadata: {},
        targetId: workspaceId,
      })
      .from(page)
      .where(sql`${auditEvents}.ctid=${page.ctid}`)
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}

export async function scrubUsageFacts(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({ ctid: sql<string>`${usageEvents}.ctid`.as('purge_ctid') })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.workspaceId, workspaceId),
          or(
            sql`${usageEvents.metadata}<>'{}'::jsonb`,
            ne(usageEvents.resourceId, workspaceId),
            ne(usageEvents.resourceType, 'workspace-tombstone'),
            sql`${usageEvents.idempotencyKey}<>${usageEvents.id}::text`,
          ),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .update(usageEvents)
      .set({
        metadata: {},
        resourceId: workspaceId,
        resourceType: 'workspace-tombstone',
        idempotencyKey: sql`${usageEvents.id}::text`,
      })
      .from(page)
      .where(sql`${usageEvents}.ctid=${page.ctid}`)
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}

export async function scrubTransportFacts(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({
        ctid: sql<string>`${transportSecurityAuditFacts}.ctid`.as('purge_ctid'),
      })
      .from(transportSecurityAuditFacts)
      .where(
        and(
          eq(transportSecurityAuditFacts.workspaceId, workspaceId),
          or(
            ne(transportSecurityAuditFacts.consumerName, 'purged'),
            sql`${transportSecurityAuditFacts.messageId}<>${transportSecurityAuditFacts.id}`,
          ),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .update(transportSecurityAuditFacts)
      .set({
        consumerName: 'purged',
        messageId: sql`${transportSecurityAuditFacts.id}`,
      })
      .from(page)
      .where(sql`${transportSecurityAuditFacts}.ctid=${page.ctid}`)
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
