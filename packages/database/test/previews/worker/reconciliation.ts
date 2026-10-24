import type { PreviewDelivery } from '../../../src/previews/contract.js';

import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';

import { workspaceId, workerPool } from './base.js';
import type { ClaimedFixture } from './acceptance.js';
import { scopedQuery } from './queries.js';

export interface ReconciliationFixture {
  attemptFenceToken: number;
  availableAt: Date;
  delivery: PreviewDelivery;
  outboxEventId: string;
}

export async function reconciliationFixture(
  claimed: ClaimedFixture,
): Promise<ReconciliationFixture> {
  const result = await scopedQuery<{
    available_at: Date;
    id: string;
    payload: unknown;
    payload_checksum: string;
  }>(
    `select id,payload,payload_checksum,available_at
     from app.outbox_events
     where workspace_id=$1 and aggregate_id=$2
       and job_name='reconcile-preview-attempt'
       and (payload->>'attemptFenceToken')::bigint=$3
     order by created_at desc,id desc
     limit 1`,
    [
      workspaceId,
      claimed.fixture.previewRunId,
      claimed.lease.attemptFenceToken,
    ],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    typeof row.payload !== 'object' ||
    row.payload === null
  )
    throw new Error('preview reconciliation outbox missing');
  const payload = row.payload as Record<string, unknown>;
  if (payload.attemptFenceToken !== claimed.lease.attemptFenceToken)
    throw new Error('preview reconciliation fence mismatch');
  return {
    attemptFenceToken: claimed.lease.attemptFenceToken,
    availableAt: row.available_at,
    delivery: {
      outboxEventId: row.id,
      payloadChecksum: row.payload_checksum,
    },
    outboxEventId: row.id,
  };
}

export async function expireLease(previewAttemptId: string): Promise<void> {
  // The worker role owns lease lifecycle columns (migration 0022), so time
  // travel for a crash proof goes through a scoped serving client.
  const result = await withTenantScopedClient(
    workerPool,
    { workspaceId },
    async (client) =>
      client.query(
        `update app.preview_attempts
         set lease_expires_at=clock_timestamp() - interval '1 second'
         where workspace_id=$1 and id=$2
         returning id`,
        [workspaceId, previewAttemptId],
      ),
  );
  if (result.rowCount !== 1) throw new Error('lease expiry injection lost');
}
