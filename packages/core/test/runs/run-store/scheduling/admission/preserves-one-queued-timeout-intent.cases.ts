import { it, expect } from 'vitest';
import { ZodError } from 'zod';

import {
  FailureNotificationContextSchema,
  asRuntime,
  checkpoint,
  createFailureNotificationStore,
  databaseUrl,
  insertRun,
  notificationDestinationId,
  notificationSecretVersionId,
  parseDatabaseConfig,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';

import { predecessorFailureNotificationContextV1Schema } from '../fixture.js';

export function registerPreservesOneQueuedTimeoutIntent(): void {
  it('preserves one queued-timeout intent through predecessor rejection and R1 rollback recovery', async () => {
    const runId = await insertRun({
      failureNotificationPolicy: {
        destinationId: notificationDestinationId,
        destinationConfigVersion: 1,
        sideEffectClass: 'idempotent_with_key',
        connectionSecretVersionId: notificationSecretVersionId,
      },
    });
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'timed_out',
        nextEventSequence: 3,
        invocations: [],
      }),
      events: [
        {
          sequence: 2,
          name: 'run.timed_out' as const,
          occurredAt: '2026-08-24T10:01:00.000Z',
          reasonCode: 'execution.deadline_exceeded',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const input = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan,
    };

    await expect(
      ownedDeliveryStore.commitAdvancePlan(input),
    ).resolves.toMatchObject({
      kind: 'committed',
    });
    await expect(
      ownedDeliveryStore.commitAdvancePlan(input),
    ).resolves.toMatchObject({
      kind: 'already_committed',
    });

    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        context: Record<string, unknown>;
        intent_count: number;
        outbox_count: number;
        run_status: string;
        terminal_event_count: number;
      }>(
        `select run.status run_status,
                count(distinct event.sequence) filter (
                  where event.type='run.timed_out'
                )::int terminal_event_count,
                count(distinct intent.id)::int intent_count,
                count(distinct outbox.id)::int outbox_count,
                min(intent.context::text)::jsonb context
           from app.workflow_runs run
           left join app.run_events event
             on event.workspace_id=run.workspace_id
            and event.workflow_run_id=run.id
           left join app.run_failure_notification_intents intent
             on intent.workspace_id=run.workspace_id
            and intent.workflow_run_id=run.id
           left join app.outbox_events outbox on outbox.aggregate_id=intent.id
          where run.workspace_id=$1 and run.id=$2
          group by run.status`,
        [workspaceA, runId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({
      run_status: 'timed_out',
      terminal_event_count: 1,
      intent_count: 1,
      outbox_count: 1,
    });
    expect(
      FailureNotificationContextSchema.parse(proof.rows[0]?.context),
    ).toMatchObject({
      terminalStatus: 'timed_out',
      primaryFailure: {
        source: 'run',
        runStatus: 'timed_out',
        safeErrorCode: 'execution.deadline_exceeded',
      },
      totalFailureCount: 1,
    });

    const identity = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        context: Record<string, unknown>;
        context_checksum: string;
        intent_id: string;
        outbox_id: string;
        payload_checksum: string;
      }>(
        `select intent.id intent_id,intent.context,intent.context_checksum,
                outbox.id outbox_id,outbox.payload_checksum
           from app.run_failure_notification_intents intent
           join app.outbox_events outbox on outbox.aggregate_id=intent.id
          where intent.workspace_id=$1 and intent.workflow_run_id=$2
          order by outbox.created_at,outbox.id limit 1`,
        [workspaceA, runId],
      ),
    );
    const first = identity.rows[0];
    if (first === undefined) throw new Error('notification fixture missing');

    await expect(
      asRuntime(workerBaseUrl, workspaceA, async (client) => {
        const selected = await client.query<{ context: unknown }>(
          `select context from app.run_failure_notification_intents
            where workspace_id=$1 and id=$2 for update`,
          [workspaceA, first.intent_id],
        );
        predecessorFailureNotificationContextV1Schema.parse(
          selected.rows[0]?.context,
        );
      }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `select 1 from app.run_failure_notification_intents
            where workspace_id=$1 and id=$2 and status='pending' and delivery_attempts=0`,
          [workspaceA, first.intent_id],
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    const claimInput = {
      workspaceId: workspaceA,
      intentId: first.intent_id,
      delivery: {
        outboxEventId: first.outbox_id,
        payloadChecksum: first.payload_checksum,
      },
      recoverySeconds: 1,
      maxAttempts: 3,
    } as const;
    const candidateStore = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
        ownerRole: 'pertexo_owner',
      }),
    );
    try {
      await expect(
        candidateStore.claimDelivery(claimInput),
      ).resolves.toMatchObject({
        kind: 'ready',
        attemptNumber: 1,
        context: first.context,
      });
    } finally {
      await candidateStore.close();
    }

    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `update app.run_failure_notification_intents
            set recovery_at=clock_timestamp()-interval '1 second'
          where workspace_id=$1 and id=$2`,
        [workspaceA, first.intent_id],
      ),
    );
    const rollbackReaderStore = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
        ownerRole: 'pertexo_owner',
      }),
    );
    try {
      await expect(rollbackReaderStore.recoverDue(10, 3)).resolves.toBe(1);
      const recovered = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          context: Record<string, unknown>;
          context_checksum: string;
          delivery_attempts: number;
          intent_count: number;
          outbox_count: number;
          outbox_id: string;
          payload_checksum: string;
        }>(
          `select intent.context,intent.context_checksum,intent.delivery_attempts,
                    (select count(*)::int from app.run_failure_notification_intents other
                      where other.workflow_run_id=intent.workflow_run_id) intent_count,
                    (select count(*)::int from app.outbox_events other
                      where other.aggregate_id=intent.id) outbox_count,
                    outbox.id outbox_id,outbox.payload_checksum
               from app.run_failure_notification_intents intent
               join lateral (
                 select id,payload_checksum from app.outbox_events
                  where aggregate_id=intent.id order by created_at desc,id desc limit 1
               ) outbox on true
              where intent.workspace_id=$1 and intent.id=$2`,
          [workspaceA, first.intent_id],
        ),
      );
      const retry = recovered.rows[0];
      expect(retry).toMatchObject({
        context: first.context,
        context_checksum: first.context_checksum,
        delivery_attempts: 1,
        intent_count: 1,
        outbox_count: 2,
      });
      if (retry === undefined) throw new Error('recovery fixture missing');
      const reclaimed = await rollbackReaderStore.claimDelivery({
        ...claimInput,
        delivery: {
          outboxEventId: retry.outbox_id,
          payloadChecksum: retry.payload_checksum,
        },
      });
      expect(reclaimed).toMatchObject({
        kind: 'ready',
        attemptNumber: 2,
        context: first.context,
      });
      if (reclaimed.kind !== 'ready')
        throw new Error('Recovered notification was not claimable');
      await expect(
        rollbackReaderStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: reclaimed.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            kind: 'definite_failure',
            safeErrorCode: 'provider.rejected',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
    } finally {
      await rollbackReaderStore.close();
    }
  });
}
