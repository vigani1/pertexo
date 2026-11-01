import { it, expect } from 'vitest';
import { NodeAttemptReconciliationRequiredError } from '../../../../../src/testing.js';

import { createOperatorCommandDatabase } from '../../../../../src/operator/repository.js';
import {
  UnknownOutcomeReconciliationMismatchError,
  UnknownOutcomeReconciliationStateError,
  reconcileUnknownOutcomeEvidence,
} from '../../../../../src/testing.js';
import { createWorkspaceDatabase } from '@pertexo/database/testing';
import {
  asAdmin,
  asOwner,
  asRuntime,
  databaseUrl,
  nodeAttemptStore,
  parseDatabaseConfig,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { claimDispatchAttempt } from '../fixture.js';

export function registerReconcilesDurableUnknownOutcomeEvidence(): void {
  it('reconciles durable unknown-outcome evidence exactly once and rejects mismatches and stale state', async () => {
    const workerDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
      }),
    );
    const prepareEvidence = async (suffix: string) => {
      const lease = await claimDispatchAttempt(
        `unknown-evidence-${suffix}-${randomUUID()}`,
      );
      await nodeAttemptStore.markDispatched({
        lease,
        signal: new AbortController().signal,
      });
      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome: {
            status: 'outcome_unknown',
            safeErrorCode: 'execution.outcome_unknown',
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: 'committed' });

      const evidenceCommandId = randomUUID();
      const operator = createOperatorCommandDatabase(
        parseDatabaseConfig({
          connectionString: databaseUrl(
            process.env.DATABASE_MAINTENANCE_URL ??
              'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
          ),
          max: 1,
        }),
      );
      try {
        await expect(
          operator.recordUnknownOutcomeEvidence({
            actorRef: 'operator:test',
            attemptId: lease.attemptId,
            commandId: evidenceCommandId,
            evidenceKind: 'provider_receipt',
            evidenceRef: { reference: `receipt-${suffix}` },
            reason: 'verify durable provider evidence',
            workspaceId: workspaceA,
          }),
        ).resolves.toMatchObject({ outcome: 'evidence_recorded' });
      } finally {
        await operator.close();
      }
      const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
             where workspace_id=$1 and aggregate_id=$2
               and job_name='reconcile-unknown-outcome'
             order by created_at desc limit 1`,
          [workspaceA, lease.attemptId],
        ),
      );
      const delivery = outbox.rows[0];
      if (delivery === undefined)
        throw new Error('Unknown-outcome reconciliation delivery missing');
      return { delivery, evidenceCommandId, lease };
    };

    try {
      const current = await prepareEvidence('current');
      const input = {
        attemptId: current.lease.attemptId,
        delivery: {
          outboxEventId: current.delivery.id,
          payloadChecksum: current.delivery.payload_checksum,
        },
        evidenceCommandId: current.evidenceCommandId,
        workspaceId: workspaceA,
      };
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, input),
      ).resolves.toEqual({ kind: 'processed' });
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, input),
      ).resolves.toEqual({ kind: 'duplicate' });

      const commandMismatch = await prepareEvidence('command-mismatch');
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, {
          attemptId: commandMismatch.lease.attemptId,
          delivery: {
            outboxEventId: commandMismatch.delivery.id,
            payloadChecksum: commandMismatch.delivery.payload_checksum,
          },
          evidenceCommandId: randomUUID(),
          workspaceId: workspaceA,
        }),
      ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationMismatchError);

      const checksumMismatch = await prepareEvidence('checksum-mismatch');
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, {
          attemptId: checksumMismatch.lease.attemptId,
          delivery: {
            outboxEventId: checksumMismatch.delivery.id,
            payloadChecksum: 'f'.repeat(64),
          },
          evidenceCommandId: checksumMismatch.evidenceCommandId,
          workspaceId: workspaceA,
        }),
      ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationMismatchError);

      const mismatchReceipts = await asRuntime(
        workerBaseUrl,
        workspaceA,
        (client) =>
          client.query<{ completed: number; message_id: string }>(
            `select message_id,count(completed_at)::int completed
               from app.inbox_receipts
              where workspace_id=$1 and consumer_name='unknown-outcome-reconciler'
                and message_id=any($2::uuid[])
              group by message_id`,
            [
              workspaceA,
              [commandMismatch.delivery.id, checksumMismatch.delivery.id],
            ],
          ),
      );
      expect(mismatchReceipts.rows).toEqual([]);

      const stale = await prepareEvidence('stale');
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.node_attempts set status='succeeded'
             where workspace_id=$1 and id=$2`,
          [workspaceA, stale.lease.attemptId],
        ),
      );
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, {
          attemptId: stale.lease.attemptId,
          delivery: {
            outboxEventId: stale.delivery.id,
            payloadChecksum: stale.delivery.payload_checksum,
          },
          evidenceCommandId: stale.evidenceCommandId,
          workspaceId: workspaceA,
        }),
      ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationStateError);

      const receipts = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ attempt_status: string; completed: number }>(
          `select count(completed_at)::int completed,
              (select status from app.node_attempts
                where workspace_id=$1 and id=$3) attempt_status
               from app.inbox_receipts
              where workspace_id=$1 and consumer_name='unknown-outcome-reconciler'
                and message_id=$2`,
          [workspaceA, stale.delivery.id, stale.lease.attemptId],
        ),
      );
      expect(receipts.rows).toEqual([
        { attempt_status: 'succeeded', completed: 0 },
      ]);
    } finally {
      await workerDatabase.close();
    }
  });

  it('rejects completion when only the durable attempt fence is stale', async () => {
    const lease = await claimDispatchAttempt(
      `stale-completion-${randomUUID()}`,
    );
    await asAdmin((client) =>
      client.query(
        `update app.node_attempts
            set fence_token=fence_token+1
          where workspace_id=$1 and id=$2`,
        [workspaceA, lease.attemptId],
      ),
    );

    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome: { status: 'succeeded', output: { accepted: false } },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);

    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          completed_at: Date | null;
          fence_token: string;
          status: string;
        }>(
          `select status,fence_token::text,completed_at
             from app.node_attempts
            where workspace_id=$1 and id=$2`,
          [workspaceA, lease.attemptId],
        ),
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          completed_at: null,
          fence_token: String(lease.fenceToken + 1),
          status: 'running',
        },
      ],
    });
  });
}
