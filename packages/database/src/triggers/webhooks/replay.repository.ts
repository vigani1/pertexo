import { alias } from 'drizzle-orm/pg-core';
import { webhookTriggerReplayRecords } from '../../schema/triggers/deliveries.js';
import { triggerCoordinatedEvents as events } from '../../schema/event-coordination/records.js';
import type {
  EventCoordinationReceipt,
  EventCoordinationReason,
} from '@pertexo/workflow-model';
import { coordinatedReceipt } from '../coordination/events.repository.js';
import { and, eq, sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { WebhookDeliveryReplayMismatchError } from './errors.js';

/** Endpoint-scoped deduplication records for ADR 026 webhook replay. */
export type WebhookReplayRecord = NonNullable<
  Awaited<ReturnType<typeof readLockedReplay>>
>;
export type WebhookReplayIdentity = Readonly<{
  endpointId: string;
  dedupeKind: 'fingerprint' | 'keyed';
  dedupeKeyHash: string;
}>;
export async function lockEndpointDedupeKey(
  transaction: WorkspaceTransaction,
  identity: WebhookReplayIdentity,
): Promise<void> {
  await transaction.db.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(
      ${`${identity.endpointId}:${identity.dedupeKind}:${identity.dedupeKeyHash}`},0))
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
        eq(replay.dedupeKind, identity.dedupeKind),
        eq(replay.dedupeKeyHash, identity.dedupeKeyHash),
      ),
    )
    .for('update', { of: replay });
  return result[0];
}
export function resolveExactReplay(
  replay: WebhookReplayRecord,
  requestFingerprint: string,
):
  | Readonly<{ runId: string; replayed: true }>
  | Readonly<{ skipped: true; reason: 'concurrency_limit' }>
  | EventCoordinationReceipt {
  if (replay.request_fingerprint !== requestFingerprint)
    throw new WebhookDeliveryReplayMismatchError();
  if (replay.skip_reason === 'concurrency_limit')
    return Object.freeze({ skipped: true, reason: 'concurrency_limit' });
  const {
    coordination_event_id,
    workflow_run_id,
    initial_outcome,
    initial_status,
    coordination_reason,
  } = replay;
  const coordinatedWithoutRun =
    coordination_event_id !== null &&
    workflow_run_id === null &&
    initial_outcome !== null &&
    initial_status !== null;
  if (coordinatedWithoutRun)
    return coordinatedReceipt(
      coordination_event_id,
      initial_outcome,
      initial_status,
      initial_status === 'pending' ? null : coordination_reason,
    );
  if (workflow_run_id === null)
    throw new Error('Webhook replay record is incomplete');
  return Object.freeze({ runId: workflow_run_id, replayed: true });
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
        eq(webhookTriggerReplayRecords.dedupeKind, identity.dedupeKind),
        eq(webhookTriggerReplayRecords.dedupeKeyHash, identity.dedupeKeyHash),
      ),
    );
}
