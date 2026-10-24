import type {
  EventCoordinationReceipt,
  EventCoordinationReason,
} from '@pertexo/workflow-model';
import { coordinatedReceipt } from '../coordination/events.repository.js';
import { sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { WebhookDeliveryReplayMismatchError } from './errors.js';

/** Endpoint-scoped deduplication records for ADR 026 webhook replay. */
export type WebhookReplayRecord = Readonly<{
  request_fingerprint: string;
  workflow_run_id: string | null;
  active: boolean;
  skip_reason: 'concurrency_limit' | null;
  coordination_event_id: string | null;
  initial_outcome: EventCoordinationReceipt['outcome'] | null;
  initial_status: EventCoordinationReceipt['status'] | null;
  coordination_reason: EventCoordinationReason | null;
}>;
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
): Promise<WebhookReplayRecord | undefined> {
  const result = await transaction.db.execute<WebhookReplayRecord>(sql`
    select replay.request_fingerprint,replay.workflow_run_id,replay.skip_reason,replay.coordination_event_id,
           replay.expires_at>clock_timestamp() active,event.initial_outcome,event.initial_status,event.reason coordination_reason
      from app.webhook_trigger_replay_records replay
      left join app.trigger_coordinated_events event on event.workspace_id=replay.workspace_id and event.id=replay.coordination_event_id
     where replay.workspace_id=${transaction.workspaceId}
       and replay.endpoint_id=${identity.endpointId}
       and replay.dedupe_kind=${identity.dedupeKind}
       and replay.dedupe_key_hash=${identity.dedupeKeyHash}
     for update of replay
  `);
  return result.rows[0];
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
  const coordinatedWithoutRun =
    replay.coordination_event_id !== null &&
    replay.workflow_run_id === null &&
    replay.initial_outcome !== null &&
    replay.initial_status !== null;
  if (coordinatedWithoutRun)
    return coordinatedReceipt(
      replay.coordination_event_id,
      replay.initial_outcome,
      replay.initial_status,
      replay.initial_status === 'pending' ? null : replay.coordination_reason,
    );
  if (replay.workflow_run_id === null)
    throw new Error('Webhook replay record is incomplete');
  return Object.freeze({ runId: replay.workflow_run_id, replayed: true });
}
export async function deleteExpiredReplay(
  transaction: WorkspaceTransaction,
  identity: WebhookReplayIdentity,
): Promise<void> {
  await transaction.db.execute(sql`
    delete from app.webhook_trigger_replay_records
     where workspace_id=${transaction.workspaceId}
       and endpoint_id=${identity.endpointId}
       and dedupe_kind=${identity.dedupeKind}
       and dedupe_key_hash=${identity.dedupeKeyHash}
  `);
}
