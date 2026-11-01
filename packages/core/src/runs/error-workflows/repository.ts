import { outboxEvents, inboxReceipts } from '@pertexo/database/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
  canonicalOutboxPayloadChecksum,
} from '@pertexo/database/primitives';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.js';
import { ErrorWorkflowDeliveryMismatchError } from './errors.js';
import type { ErrorWorkflowStore } from './contract.js';
import { acceptErrorWorkflow } from './accept.repository.js';
import { DELIVERY_CONSUMER } from '../../outbox/delivery-consumers.js';

const consumerName = DELIVERY_CONSUMER['start-error-workflow'];

/** Admission, intent resolution and transport receipt share one commit. */
export function createErrorWorkflowStore(
  config: DatabaseConfig,
  prepare: InitialCheckpointFactory,
  runtime?: DatabaseRuntime,
): ErrorWorkflowStore {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    close: () => lease.close(),
    dispatch: async (input) => {
      await withTenantScopedClient(
        lease.pool,
        { workspaceId: input.workspaceId },
        async (client) => {
          const db = drizzle(client);
          const [authoritative] = await db
            .select({
              payload: outboxEvents.payload,
              payload_checksum: outboxEvents.payloadChecksum,
            })
            .from(outboxEvents)
            .where(
              and(
                eq(outboxEvents.workspaceId, input.workspaceId),
                eq(outboxEvents.id, input.outboxEventId),
                eq(outboxEvents.aggregateId, input.sourceRunId),
                eq(outboxEvents.aggregateType, 'workflow-run'),
                eq(outboxEvents.jobName, 'start-error-workflow'),
              ),
            )
            .catch(rethrowQueryFailure);
          if (
            authoritative?.payload_checksum !== input.payloadChecksum ||
            canonicalOutboxPayloadChecksum(authoritative.payload) !==
              input.payloadChecksum
          )
            throw new ErrorWorkflowDeliveryMismatchError();
          // The unique receipt serializes duplicates before the intent can change delivery.
          await db
            .execute(
              sql`select app.lock_workspace_run_admission(${input.workspaceId})`,
            )
            .catch(rethrowQueryFailure);
          const claimed = await db
            .insert(inboxReceipts)
            .values({
              consumerName,
              messageId: input.outboxEventId,
              workspaceId: input.workspaceId,
              payloadChecksum: input.payloadChecksum,
            })
            .onConflictDoNothing({
              target: [inboxReceipts.consumerName, inboxReceipts.messageId],
            })
            .returning({ messageId: inboxReceipts.messageId })
            .catch(rethrowQueryFailure);
          if (claimed.length !== 1) {
            const [receipt] = await db
              .select({
                payload_checksum: inboxReceipts.payloadChecksum,
                completed_at: inboxReceipts.completedAt,
              })
              .from(inboxReceipts)
              .where(
                and(
                  eq(inboxReceipts.workspaceId, input.workspaceId),
                  eq(inboxReceipts.consumerName, consumerName),
                  eq(inboxReceipts.messageId, input.outboxEventId),
                ),
              )
              .for('update')
              .catch(rethrowQueryFailure);
            if (
              receipt?.payload_checksum !== input.payloadChecksum ||
              receipt.completed_at === null
            )
              throw new ErrorWorkflowDeliveryMismatchError();
            return;
          }
          await acceptErrorWorkflow(client, input, prepare);
          const completed = await db
            .update(inboxReceipts)
            .set({ completedAt: sql`clock_timestamp()` })
            .where(
              and(
                eq(inboxReceipts.consumerName, consumerName),
                eq(inboxReceipts.messageId, input.outboxEventId),
                eq(inboxReceipts.workspaceId, input.workspaceId),
                eq(inboxReceipts.payloadChecksum, input.payloadChecksum),
                isNull(inboxReceipts.completedAt),
              ),
            )
            .returning({ id: inboxReceipts.messageId })
            .catch(rethrowQueryFailure);
          if (completed.length !== 1)
            throw new ErrorWorkflowDeliveryMismatchError();
        },
        { signal: input.signal },
      );
    },
  } satisfies ErrorWorkflowStore);
}
