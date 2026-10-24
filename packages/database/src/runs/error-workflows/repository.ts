import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.js';
import {
  errorWorkflowDeliveryInputSchema,
  ErrorWorkflowDeliveryMismatchError,
  type ErrorWorkflowStore,
} from './contract.js';
import { acceptErrorWorkflow } from './accept.repository.js';
export {
  ErrorWorkflowDeliveryMismatchError,
  ErrorWorkflowVersionUnavailableError,
  type ErrorWorkflowStore,
} from './contract.js';

/** Admission, intent resolution and transport receipt share one commit. */
export function createErrorWorkflowStore(
  config: DatabaseConfig,
  prepare: InitialCheckpointFactory,
  runtime?: DatabaseRuntime,
): ErrorWorkflowStore {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    close: () => lease.close(),
    dispatch: async (raw) => {
      const input = errorWorkflowDeliveryInputSchema.parse(raw);
      await withTenantScopedClient(
        lease.pool,
        { workspaceId: input.workspaceId },
        async (client) => {
          const delivery = await client.query<{
            payload: unknown;
            payload_checksum: string;
          }>(
            `select payload,payload_checksum from app.outbox_events where workspace_id=$1 and id=$2 and aggregate_id=$3 and aggregate_type='workflow-run' and job_name='start-error-workflow'`,
            [input.workspaceId, input.outboxEventId, input.sourceRunId],
          );
          const authoritative = delivery.rows[0];
          if (
            authoritative?.payload_checksum !== input.payloadChecksum ||
            canonicalOutboxPayloadChecksum(authoritative.payload) !==
              input.payloadChecksum
          )
            throw new ErrorWorkflowDeliveryMismatchError();
          // The unique receipt serializes duplicates before the intent can change delivery.
          await client.query('select app.lock_workspace_run_admission($1)', [
            input.workspaceId,
          ]);
          const claimed = await client.query(
            `insert into app.inbox_receipts(consumer_name,message_id,workspace_id,payload_checksum) values('error-workflow',$1,$2,$3) on conflict(consumer_name,message_id) do nothing returning message_id`,
            [input.outboxEventId, input.workspaceId, input.payloadChecksum],
          );
          if (claimed.rowCount !== 1) {
            const completed = await client.query<{
              payload_checksum: string;
              completed_at: Date | null;
            }>(
              `select payload_checksum,completed_at from app.inbox_receipts where workspace_id=$1 and consumer_name='error-workflow' and message_id=$2 for update`,
              [input.workspaceId, input.outboxEventId],
            );
            const receipt = completed.rows[0];
            if (
              receipt?.payload_checksum !== input.payloadChecksum ||
              receipt.completed_at === null
            )
              throw new ErrorWorkflowDeliveryMismatchError();
            return;
          }
          await acceptErrorWorkflow(client, input, prepare);
          const completed = await client.query(
            `update app.inbox_receipts set completed_at=clock_timestamp() where consumer_name='error-workflow' and message_id=$1 and workspace_id=$2 and payload_checksum=$3 and completed_at is null`,
            [input.outboxEventId, input.workspaceId, input.payloadChecksum],
          );
          if (completed.rowCount !== 1)
            throw new ErrorWorkflowDeliveryMismatchError();
        },
        { signal: input.signal },
      );
    },
  } satisfies ErrorWorkflowStore);
}
