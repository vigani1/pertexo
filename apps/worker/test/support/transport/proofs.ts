import { randomUUID } from 'node:crypto';

import type { createWorkspaceDatabase } from '@pertexo/database/testing';
import { consumeInboxMessage } from '@pertexo/core/testing';
import { insertOutboxEvent } from '@pertexo/database/testing';
import { JOB_NAME } from '@pertexo/queue';

import { sql } from 'drizzle-orm';

export function createTransportProofOperations(
  context: Readonly<{
    proofIds: Set<string>;
    requireApiDatabase: () => ReturnType<typeof createWorkspaceDatabase>;
    requireWorkerDatabase: () => ReturnType<typeof createWorkspaceDatabase>;
    workspaceId: string;
    checksum: (value: unknown) => string;
  }>,
) {
  const {
    proofIds,
    requireApiDatabase,
    requireWorkerDatabase,
    workspaceId,
    checksum,
  } = context;
  const insertRunEvent = async (
    id = randomUUID(),
    traceparent?: string,
  ): Promise<string> => {
    proofIds.add(id);
    const payload = {
      runId: randomUUID(),
      ...(traceparent ? { traceparent } : {}),
    };
    await requireApiDatabase().withWorkspace(
      workspaceId,
      async (transaction) => {
        await transaction.db.execute(sql`
        insert into app.workflow_runs (
          id,workspace_id,workflow_id,workflow_version_id,trigger_type,status
        ) values (
          ${payload.runId},${workspaceId},${randomUUID()},${randomUUID()},'manual','succeeded'
        )
      `);
        await insertOutboxEvent(transaction, {
          aggregateId: payload.runId,
          aggregateType: 'workflow-run',
          availableAt: new Date(0),
          id,
          jobName: JOB_NAME.advanceWorkflowRun,
          payload,
          payloadChecksum: checksum(payload),
        });
      },
    );
    return id;
  };

  const consumeProof = async (
    messageId: string,
    logicalAttemptId: string,
    providerIntent?: Readonly<{
      attemptId: string;
      idempotencyKey: string;
      nodeRunId: string;
      outboxEventId: string;
      runId: string;
      traceparent?: string;
    }>,
  ) =>
    consumeInboxMessage(requireWorkerDatabase(), workspaceId, {
      message: {
        consumerName: 'worker.phase0-proof',
        messageId,
        payloadChecksum: checksum({ logicalAttemptId }),
      },
      operation: async (transaction) => {
        const { db, workspaceId: activeWorkspaceId } = transaction;
        await db.execute(sql`
          insert into app.queue_duplicate_probe_attempts
            (id, workspace_id, logical_attempt_id)
          values (${randomUUID()}, ${activeWorkspaceId}, ${logicalAttemptId})
        `);
        await db.execute(sql`
          insert into app.queue_duplicate_probe_events
            (id, workspace_id, logical_attempt_id, sequence)
          values (${randomUUID()}, ${activeWorkspaceId}, ${logicalAttemptId}, 1)
        `);
        await db.execute(sql`
          insert into app.queue_duplicate_probe_usage
            (id, workspace_id, idempotency_key, quantity)
          values (${randomUUID()}, ${activeWorkspaceId}, ${`usage:${logicalAttemptId}`}, 1)
        `);
        if (providerIntent !== undefined) {
          const payload = {
            attemptId: providerIntent.attemptId,
            nodeRunId: providerIntent.nodeRunId,
            runId: providerIntent.runId,
            ...(providerIntent.traceparent
              ? { traceparent: providerIntent.traceparent }
              : {}),
          };
          await insertOutboxEvent(transaction, {
            aggregateId: providerIntent.attemptId,
            aggregateType: 'provider-intent',
            id: providerIntent.outboxEventId,
            jobName: JOB_NAME.executeNodeAttempt,
            payload,
            payloadChecksum: checksum(payload),
          });
          await db.execute(sql`
            insert into app.queue_duplicate_probe_provider_intents
              (
                id,
                workspace_id,
                logical_attempt_id,
                outbox_event_id,
                idempotency_key
              )
            values (
              ${providerIntent.attemptId},
              ${activeWorkspaceId},
              ${logicalAttemptId},
              ${providerIntent.outboxEventId},
              ${providerIntent.idempotencyKey}
            )
          `);
        }
        return logicalAttemptId;
      },
    });

  return { insertRunEvent, consumeProof };
}
