import { workflowInputCasePayloads } from '../../schema/authoring/input-cases.js';
import { nodeRuns } from '../../schema/runs/execution.js';
import { auditEvents, usageEvents } from '../../schema/foundation.js';
import { transportSecurityAuditFacts } from '../../schema/transport.js';
import { workspaceCreationIdempotencyRecords } from '../../schema/runs/support.js';
import { workflows } from '../../schema/authoring/workflows.js';
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '../../platform/query-errors.js';

export async function purgeInputPayloads(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({
        caseId: workflowInputCasePayloads.caseId,
        revision: workflowInputCasePayloads.revision,
        bytes:
          sql<number>`sum(${workflowInputCasePayloads.canonicalBytes}) over (order by ${workflowInputCasePayloads.caseId},${workflowInputCasePayloads.revision})`.as(
            'bytes',
          ),
      })
      .from(workflowInputCasePayloads)
      .where(eq(workflowInputCasePayloads.workspaceId, workspaceId))
      .orderBy(
        asc(workflowInputCasePayloads.caseId),
        asc(workflowInputCasePayloads.revision),
      )
      .limit(Math.min(pageSize, 100)),
  );
  return (
    await db
      .with(page)
      .delete(workflowInputCasePayloads)
      .where(
        and(
          eq(workflowInputCasePayloads.workspaceId, workspaceId),
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(
                and(
                  eq(page.caseId, workflowInputCasePayloads.caseId),
                  eq(page.revision, workflowInputCasePayloads.revision),
                  lte(page.bytes, 1_048_576),
                ),
              ),
          ),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function clearCurrentAttempts(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({ ctid: sql<string>`${nodeRuns}.ctid`.as('purge_ctid') })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.workspaceId, workspaceId),
          isNotNull(nodeRuns.currentAttemptId),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .update(nodeRuns)
      .set({ currentAttemptId: null, currentAttemptNumber: null })
      .from(page)
      .where(sql`${nodeRuns}.ctid=${page.ctid}`)
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
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
export async function purgeCreationReceipts(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({
        ctid: sql<string>`${workspaceCreationIdempotencyRecords}.ctid`.as(
          'ctid',
        ),
      })
      .from(workspaceCreationIdempotencyRecords)
      .where(eq(workspaceCreationIdempotencyRecords.resourceId, workspaceId))
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .delete(workspaceCreationIdempotencyRecords)
      .where(
        inArray(
          sql<string>`${workspaceCreationIdempotencyRecords}.ctid`,
          db.select({ ctid: page.ctid }).from(page),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function clearPublishedVersions(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({ ctid: sql<string>`${workflows}.ctid`.as('purge_ctid') })
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          isNotNull(workflows.publishedVersionId),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .update(workflows)
      .set({ publishedVersionId: null })
      .from(page)
      .where(sql`${workflows}.ctid=${page.ctid}`)
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
