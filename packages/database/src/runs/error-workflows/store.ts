import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.js';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.js';
import {
  errorWorkflowDeliveryInputSchema,
  ErrorWorkflowDeliveryMismatchError,
  type ErrorWorkflowStore,
} from './contract.js';
import { acceptErrorWorkflow } from './accept.js';
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
          await acceptErrorWorkflow(client, input, prepare);
          await client.query(
            `insert into app.inbox_receipts(consumer_name,message_id,workspace_id,payload_checksum,completed_at) values('error-workflow',$1,$2,$3,clock_timestamp()) on conflict(consumer_name,message_id) do nothing`,
            [input.outboxEventId, input.workspaceId, input.payloadChecksum],
          );
        },
        { signal: input.signal },
      );
    },
  } satisfies ErrorWorkflowStore);
}
