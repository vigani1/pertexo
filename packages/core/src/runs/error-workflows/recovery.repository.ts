import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  canonicalOutboxPayloadChecksum,
  rethrowQueryFailure,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import {
  outboxEvents,
  runErrorWorkflowIntents,
} from '@pertexo/database/schema';
import { lockWorkspaceRunAdmission } from '../../shared/workspace-fence.repository.js';
import type { StalledWorkRecovery } from '../stalled/stalled-work.types.js';

/** A failed delivery remains due until its owning intent is reconciled. */
export function readFailedErrorWorkflowDeliveries(pool: Pool, limit: number) {
  return drizzle(pool)
    .select({
      id: outboxEvents.id,
      workspaceId: outboxEvents.workspaceId,
      sourceRunId: outboxEvents.aggregateId,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.jobName, 'start-error-workflow'),
        eq(outboxEvents.aggregateType, 'workflow-run'),
        isNotNull(outboxEvents.failedAt),
        lte(outboxEvents.deliveryDueAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(asc(outboxEvents.deliveryDueAt), asc(outboxEvents.id))
    .limit(limit)
    .catch(rethrowQueryFailure);
}

/** Workspace → intent → failed outbox; dispatch's intent fence chooses one winner. */
export async function replaceFailedErrorWorkflowDelivery(
  transaction: WorkspaceTransaction,
  delivery: Awaited<
    ReturnType<typeof readFailedErrorWorkflowDeliveries>
  >[number],
): Promise<StalledWorkRecovery | undefined> {
  const { db, workspaceId } = transaction;
  await lockWorkspaceRunAdmission(db, workspaceId);
  const [intent] = await db
    .select({
      status: runErrorWorkflowIntents.status,
      outboxEventId: runErrorWorkflowIntents.outboxEventId,
    })
    .from(runErrorWorkflowIntents)
    .where(
      and(
        eq(runErrorWorkflowIntents.workspaceId, workspaceId),
        eq(runErrorWorkflowIntents.sourceRunId, delivery.sourceRunId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const [event] = await db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.id, delivery.id),
        eq(outboxEvents.jobName, 'start-error-workflow'),
        eq(outboxEvents.aggregateType, 'workflow-run'),
        eq(outboxEvents.aggregateId, delivery.sourceRunId),
        isNotNull(outboxEvents.failedAt),
        lte(outboxEvents.deliveryDueAt, sql`clock_timestamp()`),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (event === undefined) return undefined;
  await db
    .update(outboxEvents)
    .set({ deliveryDueAt: null, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.id, delivery.id),
      ),
    )
    .catch(rethrowQueryFailure);
  if (intent?.status !== 'pending' || intent.outboxEventId !== delivery.id)
    return undefined;
  const outboxEventId = generatePersistedId();
  const payload = {
    workspaceId,
    sourceRunId: delivery.sourceRunId,
    outboxEventId,
  };
  await db
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId,
      jobName: 'start-error-workflow',
      aggregateType: 'workflow-run',
      aggregateId: delivery.sourceRunId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    })
    .catch(rethrowQueryFailure);
  await db
    .update(runErrorWorkflowIntents)
    .set({ outboxEventId })
    .where(
      and(
        eq(runErrorWorkflowIntents.workspaceId, workspaceId),
        eq(runErrorWorkflowIntents.sourceRunId, delivery.sourceRunId),
        eq(runErrorWorkflowIntents.status, 'pending'),
        eq(runErrorWorkflowIntents.outboxEventId, delivery.id),
      ),
    )
    .catch(rethrowQueryFailure);
  return {
    kind: 'delivery_replaced',
    workspaceId,
    runId: delivery.sourceRunId,
    jobName: 'start-error-workflow',
    replacedEventId: delivery.id,
    outboxEventId,
  };
}
