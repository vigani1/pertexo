import { sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '../tenant-access/workspace.js';
import { WebhookDeliveryReplayMismatchError } from './webhook-trigger-errors.js';

/** Endpoint-scoped deduplication records for ADR 026 webhook replay. */
export type WebhookReplayRecord = Readonly<{
  request_fingerprint: string;
  workflow_run_id: string | null;
  active: boolean;
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
    select request_fingerprint,workflow_run_id,
           expires_at>clock_timestamp() active
      from app.webhook_trigger_replay_records
     where workspace_id=${transaction.workspaceId}
       and endpoint_id=${identity.endpointId}
       and dedupe_kind=${identity.dedupeKind}
       and dedupe_key_hash=${identity.dedupeKeyHash}
     for update
  `);
  return result.rows[0];
}
export function resolveExactReplay(
  replay: WebhookReplayRecord,
  requestFingerprint: string,
): Readonly<{ runId: string; replayed: true }> {
  if (replay.request_fingerprint !== requestFingerprint)
    throw new WebhookDeliveryReplayMismatchError();
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
