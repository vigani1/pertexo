import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as digestSchema } from '../validation/persisted-primitives.js';

import type { DatabaseConfig } from '../config.js';
import { canonicalOutboxPayloadChecksum } from '../execution/outbox.js';
import { reconcileActiveWorkflowTriggers } from './workflow-trigger-materialization.js';
import {
  WorkflowTriggerReconciliationMismatchError,
  WorkflowTriggerStalePublicationError,
} from './workflow-trigger-errors.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';
import { deactivateArchivedWorkflowTriggers } from './workflow-trigger-activation.js';
import {
  readHealth,
  refreshWorkflowActivation,
  type WorkflowTriggerHealth,
} from './workflow-trigger-health.js';
export type { WorkflowTriggerHealth } from './workflow-trigger-health.js';

const uuidSchema = z.uuid();
const reconciliationPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    workflowId: z.uuid(),
    publishedVersionId: z.uuid(),
    traceparent: z.string().optional(),
  })
  .strict();
const safeReasonSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u);

export interface WorkflowTriggerReconciliationDatabase {
  reconcile(
    input: Readonly<{
      workspaceId: string;
      workflowId: string;
      publishedVersionId: string;
      outboxEventId: string;
      delivery?: Readonly<{
        outboxEventId: string;
        payloadChecksum: string;
      }>;
    }>,
  ): Promise<readonly WorkflowTriggerHealth[]>;
  recordFailure(
    input: Readonly<{
      workspaceId: string;
      workflowId: string;
      publishedVersionId: string;
      reason: string;
    }>,
  ): Promise<void>;
  close(): Promise<void>;
}

export {
  WorkflowTriggerReconciliationMismatchError,
  WorkflowTriggerStalePublicationError,
} from './workflow-trigger-errors.js';

const reconciliationConsumerName = 'trigger-runtime.reconciliation.v1';

async function completeReceipt(
  client: PoolClient,
  workspaceId: string,
  outboxEventId: string,
  payloadChecksum: string,
): Promise<void> {
  const result = await client.query(
    `update app.inbox_receipts set completed_at=clock_timestamp()
      where consumer_name=$1 and message_id=$2 and workspace_id=$3
        and payload_checksum=$4 and completed_at is null`,
    [reconciliationConsumerName, outboxEventId, workspaceId, payloadChecksum],
  );
  if (result.rowCount !== 1)
    throw new WorkflowTriggerReconciliationMismatchError(
      'Reconciliation inbox receipt completion was lost',
    );
}

export function createWorkflowTriggerReconciliationDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkflowTriggerReconciliationDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    reconcile: async (
      input: Parameters<WorkflowTriggerReconciliationDatabase['reconcile']>[0],
    ) => {
      const outcome = await withTenantScopedClient(
        pool,
        { workspaceId: uuidSchema.parse(input.workspaceId) },
        async (client) => {
          const workflowId = uuidSchema.parse(input.workflowId);
          const versionId = uuidSchema.parse(input.publishedVersionId);
          const outboxEventId = uuidSchema.parse(input.outboxEventId);
          const event = await client.query<{
            aggregate_id: string;
            aggregate_type: string;
            job_name: string;
            payload: unknown;
            payload_checksum: string;
            schema_version: number;
          }>(
            `select aggregate_id,aggregate_type,job_name,payload,payload_checksum,schema_version
               from app.outbox_events where workspace_id=$1 and id=$2`,
            [input.workspaceId, outboxEventId],
          );
          const eventRow = event.rows[0];
          let payload: z.output<typeof reconciliationPayloadSchema>;
          try {
            payload = reconciliationPayloadSchema.parse(eventRow?.payload);
          } catch {
            throw new WorkflowTriggerReconciliationMismatchError(
              'Reconciliation outbox payload is invalid',
            );
          }
          if (eventRow === undefined)
            throw new WorkflowTriggerReconciliationMismatchError(
              'Reconciliation outbox event is unavailable',
            );
          const deliveryChecksum = input.delivery?.payloadChecksum;
          if (
            eventRow.aggregate_id !== workflowId ||
            eventRow.aggregate_type !== 'workflow' ||
            eventRow.job_name !== 'reconcile-workflow-triggers' ||
            eventRow.schema_version !== 1 ||
            payload.workspaceId !== input.workspaceId ||
            payload.workflowId !== workflowId ||
            payload.publishedVersionId !== versionId ||
            payload.outboxEventId !== outboxEventId ||
            canonicalOutboxPayloadChecksum(payload) !==
              eventRow.payload_checksum ||
            (input.delivery !== undefined &&
              (uuidSchema.parse(input.delivery.outboxEventId) !==
                outboxEventId ||
                digestSchema.parse(deliveryChecksum) !==
                  eventRow.payload_checksum))
          )
            throw new WorkflowTriggerReconciliationMismatchError(
              'Reconciliation delivery failed durable transport verification',
            );

          if (input.delivery !== undefined) {
            const inserted = await client.query(
              `insert into app.inbox_receipts
                 (consumer_name,message_id,workspace_id,payload_checksum)
               values($1,$2,$3,$4) on conflict(consumer_name,message_id) do nothing
               returning message_id`,
              [
                reconciliationConsumerName,
                outboxEventId,
                input.workspaceId,
                eventRow.payload_checksum,
              ],
            );
            if (inserted.rowCount !== 1) {
              const existing = await client.query<{
                completed_at: Date | null;
                payload_checksum: string;
                workspace_id: string;
              }>(
                `select workspace_id,payload_checksum,completed_at from app.inbox_receipts
                  where consumer_name=$1 and message_id=$2 for update`,
                [reconciliationConsumerName, outboxEventId],
              );
              const receipt = existing.rows[0];
              if (
                receipt?.workspace_id !== input.workspaceId ||
                receipt.payload_checksum !== eventRow.payload_checksum ||
                receipt.completed_at === null
              )
                throw new WorkflowTriggerReconciliationMismatchError(
                  'Reconciliation inbox receipt is inconsistent',
                );
              return { kind: 'duplicate' as const };
            }
          }

          const authority = await client.query<{ lifecycle_status: string }>(
            `select lifecycle_status from app.workflows workflow
              where workflow.workspace_id=$1 and workflow.id=$2
                and workflow.published_version_id=$3
              for update`,
            [input.workspaceId, workflowId, versionId],
          );
          if (authority.rowCount !== 1) {
            if (input.delivery !== undefined)
              await completeReceipt(
                client,
                input.workspaceId,
                outboxEventId,
                eventRow.payload_checksum,
              );
            return { kind: 'stale' as const };
          }

          if (authority.rows[0]?.lifecycle_status === 'archived') {
            await deactivateArchivedWorkflowTriggers(
              client,
              input.workspaceId,
              workflowId,
            );
          } else {
            await reconcileActiveWorkflowTriggers(client, {
              workspaceId: input.workspaceId,
              workflowId,
              versionId,
            });
          }
          await refreshWorkflowActivation(
            client,
            input.workspaceId,
            workflowId,
          );
          const health = await readHealth(
            client,
            input.workspaceId,
            workflowId,
          );
          if (input.delivery !== undefined)
            await completeReceipt(
              client,
              input.workspaceId,
              outboxEventId,
              eventRow.payload_checksum,
            );
          return { kind: 'reconciled' as const, health };
        },
      );
      if (outcome.kind === 'stale')
        throw new WorkflowTriggerStalePublicationError(
          'Reconciliation no longer names the current published workflow version',
        );
      if (outcome.kind === 'duplicate') return Object.freeze([]);
      return outcome.health;
    },
    recordFailure: async (
      input: Parameters<
        WorkflowTriggerReconciliationDatabase['recordFailure']
      >[0],
    ) =>
      withTenantScopedClient(
        pool,
        { workspaceId: uuidSchema.parse(input.workspaceId) },
        async (client) => {
          const workflowId = uuidSchema.parse(input.workflowId);
          const versionId = uuidSchema.parse(input.publishedVersionId);
          const reason = safeReasonSchema.parse(input.reason);
          const authority = await client.query(
            `select id from app.workflows where workspace_id=$1 and id=$2
              and published_version_id=$3 for update`,
            [input.workspaceId, workflowId, versionId],
          );
          if (authority.rowCount !== 1) return;
          await client.query(
            `update app.workflow_triggers trigger
                set status='error',health_status='unhealthy',last_error_code=$4,
                    reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
              where trigger.workspace_id=$1 and trigger.workflow_id=$2
                and trigger.workflow_version_id=$3
                and trigger.status not in ('active','disabled')`,
            [input.workspaceId, workflowId, versionId, reason],
          );
          await refreshWorkflowActivation(
            client,
            input.workspaceId,
            workflowId,
            true,
          );
        },
      ),
    close: () => lease.close(),
  });
}

export { refreshWorkflowActivation, readHealth };
