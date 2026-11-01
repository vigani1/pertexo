import type { WebhookReplayIdentity } from './contract.js';
import { alias } from 'drizzle-orm/pg-core';
import {
  webhookTriggerReplayRecords,
  triggerCoordinatedEvents as events,
} from '@pertexo/database/schema';
import type {
  EventCoordinationReceipt,
  EventCoordinationReason,
} from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '@pertexo/database/primitives';

/** Endpoint-scoped records of an `Idempotency-Key` for ADR 026 webhook replay. */
export type WebhookReplayRecord = NonNullable<
  Awaited<ReturnType<typeof readLockedReplay>>
>;

/** Writes what this delivery ended as onto its replay record, if it has one. */
export async function recordReplayResult(
  transaction: WorkspaceTransaction,
  deliveryId: string,
  result: Partial<
    Pick<
      typeof webhookTriggerReplayRecords.$inferInsert,
      'coordinationEventId' | 'skipReason' | 'workflowRunId'
    >
  >,
): Promise<void> {
  await transaction.db
    .update(webhookTriggerReplayRecords)
    .set(result)
    .where(
      and(
        eq(webhookTriggerReplayRecords.workspaceId, transaction.workspaceId),
        eq(webhookTriggerReplayRecords.deliveryId, deliveryId),
      ),
    );
}
export async function lockEndpointDedupeKey(
  transaction: WorkspaceTransaction,
  identity: WebhookReplayIdentity,
): Promise<void> {
  await transaction.db.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(
      ${`${identity.endpointId}:${identity.dedupeKeyHash}`},0))
  `);
}
export async function readLockedReplay(
  transaction: WorkspaceTransaction,
  identity: WebhookReplayIdentity,
) {
  const replay = alias(webhookTriggerReplayRecords, 'replay');
  const result = await transaction.db
    .select({
      request_fingerprint: replay.requestFingerprint,
      workflow_run_id: replay.workflowRunId,
      skip_reason: replay.skipReason,
      coordination_event_id: replay.coordinationEventId,
      active: sql<boolean>`${replay.expiresAt}>clock_timestamp()`,
      // The no-run receipt branch is written only with coordination receipt outcomes/statuses.
      initial_outcome: sql<
        EventCoordinationReceipt['outcome'] | null
      >`${events.initialOutcome}`,
      initial_status: sql<
        EventCoordinationReceipt['status'] | null
      >`${events.initialStatus}`,
      coordination_reason: sql<EventCoordinationReason | null>`${events.reason}`,
    })
    .from(replay)
    .leftJoin(
      events,
      and(
        eq(events.workspaceId, replay.workspaceId),
        eq(events.id, replay.coordinationEventId),
      ),
    )
    .where(
      and(
        eq(replay.workspaceId, transaction.workspaceId),
        eq(replay.endpointId, identity.endpointId),
        eq(replay.dedupeKeyHash, identity.dedupeKeyHash),
      ),
    )
    .for('update', { of: replay });
  return result[0];
}
export async function deleteExpiredReplay(
  transaction: WorkspaceTransaction,
  identity: WebhookReplayIdentity,
): Promise<void> {
  await transaction.db
    .delete(webhookTriggerReplayRecords)
    .where(
      and(
        eq(webhookTriggerReplayRecords.workspaceId, transaction.workspaceId),
        eq(webhookTriggerReplayRecords.endpointId, identity.endpointId),
        eq(webhookTriggerReplayRecords.dedupeKeyHash, identity.dedupeKeyHash),
      ),
    );
}
