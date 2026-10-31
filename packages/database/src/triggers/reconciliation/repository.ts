import { and, eq, inArray, not, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  workflows,
  workflowTriggers,
} from '../../schema/authoring/workflows.js';
import {
  inboxReceipts,
  transportSecurityAuditFacts,
} from '../../schema/transport.js';
import type { WorkflowTriggerReconciliationDatabase } from './contract.js';
import {
  assertDeliveryIdentity,
  readReconciliationEvent,
} from './identity.queries.js';

import type { DatabaseConfig } from '../../config.js';

import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { deactivateArchivedWorkflowTriggers } from './activation.repository.js';
import {
  WorkflowTriggerReconciliationMismatchError,
  WorkflowTriggerStalePublicationError,
} from './errors.js';
import { readHealth, refreshWorkflowActivation } from './health.repository.js';
import { reconcileActiveWorkflowTriggers } from './materialization.repository.js';
import { DELIVERY_CONSUMER } from '../../outbox/delivery-consumers.js';

const reconciliationConsumerName =
  DELIVERY_CONSUMER['reconcile-workflow-triggers'];
const transportChecksumMismatch = Symbol('transport-checksum-mismatch');

async function completeReceipt(
  client: PoolClient,
  workspaceId: string,
  outboxEventId: string,
  payloadChecksum: string,
): Promise<void> {
  const result = await drizzle(client)
    .update(inboxReceipts)
    .set({ completedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(inboxReceipts.consumerName, reconciliationConsumerName),
        eq(inboxReceipts.messageId, outboxEventId),
        eq(inboxReceipts.workspaceId, workspaceId),
        eq(inboxReceipts.payloadChecksum, payloadChecksum),
        sql`${inboxReceipts.completedAt} is null`,
      ),
    )
    .returning({ id: inboxReceipts.messageId })
    .catch(rethrowQueryFailure);
  if (result.length !== 1)
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
    reconcile: (
      input: Parameters<WorkflowTriggerReconciliationDatabase['reconcile']>[0],
    ) => reconcileWorkflowTriggers(pool, input),
    recordFailure: (
      input: Parameters<
        WorkflowTriggerReconciliationDatabase['recordFailure']
      >[0],
    ) => recordTriggerReconciliationFailure(pool, input),
    close: () => lease.close(),
  });
}

async function reconcileWorkflowTriggers(
  pool: Pool,
  input: Parameters<WorkflowTriggerReconciliationDatabase['reconcile']>[0],
): ReturnType<WorkflowTriggerReconciliationDatabase['reconcile']> {
  const outcome = await withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId },
    async (client) => {
      const workflowId = input.workflowId;
      const versionId = input.publishedVersionId;
      const outboxEventId = input.outboxEventId;
      const verifiedEvent = await readReconciliationEvent(client, input, {
        outboxEventId,
        versionId,
        workflowId,
      });
      if (
        input.delivery !== undefined &&
        !assertDeliveryIdentity(input.delivery, verifiedEvent, outboxEventId)
      )
        return transportChecksumMismatch;

      if (input.delivery !== undefined) {
        const receipt = await claimReconciliationReceipt(
          client,
          input.workspaceId,
          outboxEventId,
          verifiedEvent.payloadChecksum,
        );
        if (receipt === 'checksum_mismatch') return transportChecksumMismatch;
        if (receipt === 'duplicate') return { kind: 'duplicate' as const };
      }

      const db = drizzle(client);
      const authority = await db
        .select({ lifecycleStatus: workflows.lifecycleStatus })
        .from(workflows)
        .where(
          and(
            eq(workflows.workspaceId, input.workspaceId),
            eq(workflows.id, workflowId),
            eq(workflows.publishedVersionId, versionId),
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
      if (authority.length !== 1) {
        if (input.delivery !== undefined)
          await completeReceipt(
            client,
            input.workspaceId,
            outboxEventId,
            verifiedEvent.payloadChecksum,
          );
        return { kind: 'stale' as const };
      }

      if (authority[0]?.lifecycleStatus === 'archived') {
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
      await refreshWorkflowActivation(client, input.workspaceId, workflowId);
      const health = await readHealth(client, input.workspaceId, workflowId);
      if (input.delivery !== undefined)
        await completeReceipt(
          client,
          input.workspaceId,
          outboxEventId,
          verifiedEvent.payloadChecksum,
        );
      return { kind: 'reconciled' as const, health };
    },
  );
  if (outcome === transportChecksumMismatch) {
    await withTenantScopedClient(
      pool,
      { workspaceId: input.workspaceId },
      async (client) => {
        await recordTransportMismatch(
          client,
          input.workspaceId,
          input.outboxEventId,
        );
      },
    );
    throw new WorkflowTriggerReconciliationMismatchError(
      'Reconciliation delivery failed durable transport verification',
    );
  }
  if (outcome.kind === 'stale')
    throw new WorkflowTriggerStalePublicationError(
      'Reconciliation no longer names the current published workflow version',
    );
  if (outcome.kind === 'duplicate') return Object.freeze([]);
  return outcome.health;
}

async function recordTriggerReconciliationFailure(
  pool: Pool,
  input: Parameters<WorkflowTriggerReconciliationDatabase['recordFailure']>[0],
): ReturnType<WorkflowTriggerReconciliationDatabase['recordFailure']> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId },
    async (client) => {
      const workflowId = input.workflowId;
      const versionId = input.publishedVersionId;
      const reason = input.reason;
      const db = drizzle(client);
      const authority = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.workspaceId, input.workspaceId),
            eq(workflows.id, workflowId),
            eq(workflows.publishedVersionId, versionId),
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
      if (authority.length !== 1) return;
      await db
        .update(workflowTriggers)
        .set({
          status: 'error',
          healthStatus: 'unhealthy',
          lastErrorCode: reason,
          reconciledAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(workflowTriggers.workspaceId, input.workspaceId),
            eq(workflowTriggers.workflowId, workflowId),
            eq(workflowTriggers.workflowVersionId, versionId),
            not(inArray(workflowTriggers.status, ['active', 'disabled'])),
          ),
        )
        .catch(rethrowQueryFailure);
      await refreshWorkflowActivation(client, input.workspaceId, workflowId, {
        failed: true,
      });
    },
  );
}
async function claimReconciliationReceipt(
  client: PoolClient,
  workspaceId: string,
  outboxEventId: string,
  payloadChecksum: string,
) {
  const db = drizzle(client);
  const inserted = await db
    .insert(inboxReceipts)
    .values({
      consumerName: reconciliationConsumerName,
      messageId: outboxEventId,
      workspaceId,
      payloadChecksum,
    })
    .onConflictDoNothing({
      target: [inboxReceipts.consumerName, inboxReceipts.messageId],
    })
    .returning({ id: inboxReceipts.messageId })
    .catch(rethrowQueryFailure);
  if (inserted.length === 1) return 'claimed';
  const existing = await db
    .select({
      workspaceId: inboxReceipts.workspaceId,
      payloadChecksum: inboxReceipts.payloadChecksum,
      completedAt: inboxReceipts.completedAt,
    })
    .from(inboxReceipts)
    .where(
      and(
        eq(inboxReceipts.consumerName, reconciliationConsumerName),
        eq(inboxReceipts.messageId, outboxEventId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const receipt = existing[0];
  if (receipt?.workspaceId !== workspaceId || receipt.completedAt === null)
    throw new WorkflowTriggerReconciliationMismatchError(
      'Reconciliation inbox receipt is inconsistent',
    );
  return receipt.payloadChecksum === payloadChecksum
    ? 'duplicate'
    : 'checksum_mismatch';
}
async function recordTransportMismatch(
  client: PoolClient,
  workspaceId: string,
  messageId: string,
): Promise<void> {
  await drizzle(client)
    .insert(transportSecurityAuditFacts)
    .values({
      id: generatePersistedId(),
      workspaceId,
      factType: 'inbox_checksum_mismatch',
      consumerName: reconciliationConsumerName,
      messageId,
    })
    .catch(rethrowQueryFailure);
}
