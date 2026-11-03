import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowVersions,
  workflowTriggers,
  workspaces,
  webhookTriggerEndpoints,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, eq, or, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';

import type { PublishedWorkflow } from '../../../runs/queries/execution/contract.js';
import { readHealth } from '../../reconciliation/health.repository.js';
import type { WorkflowTriggerHealth } from '../../reconciliation/contract.js';

import {
  WebhookDeliveryIneligibleError,
  WebhookTriggerNotFoundError,
  WebhookWorkflowPausedError,
} from '../errors.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import type {
  WebhookConfig,
  WebhookVerificationReference,
} from './contract.js';
import { endpointTakesDeliveries } from './endpoint-rules.js';

export async function oneHealth(
  client: PoolClient,
  workspaceId: string,
  triggerId: string,
): Promise<WorkflowTriggerHealth> {
  const identity = await drizzle(client)
    .select({ workflowId: workflowTriggers.workflowId })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, workspaceId),
        eq(workflowTriggers.id, triggerId),
      ),
    )
    .catch(rethrowQueryFailure);
  const workflowId = identity[0]?.workflowId;
  if (workflowId === undefined) throw new WebhookTriggerNotFoundError();
  const health = await readHealth(client, workspaceId, workflowId);
  const trigger = health.find(({ id }) => id === triggerId);
  if (trigger === undefined) throw new WebhookTriggerNotFoundError();
  return trigger;
}

/** The config this version of the trigger was published with. */
export async function readTriggerConfig(
  transaction: WorkspaceTransaction,
  triggerId: string,
  workflowVersionId: string,
): Promise<WebhookConfig | undefined> {
  const result = await transaction.db
    .select({ config: sql<WebhookConfig>`${workflowTriggers.desiredConfig}` })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, transaction.workspaceId),
        eq(workflowTriggers.id, triggerId),
        eq(workflowTriggers.workflowVersionId, workflowVersionId),
      ),
    );
  return result[0]?.config;
}

export async function executableProjection(
  transaction: WorkspaceTransaction,
  workflowVersionId: string,
): Promise<PublishedWorkflow> {
  const result = await transaction.db
    .select({
      id: workflowVersions.id,
      workspaceId: workflowVersions.workspaceId,
      workflowId: workflowVersions.workflowId,
      versionNumber: workflowVersions.versionNumber,
      checksum: workflowVersions.checksum,
      executableJson: workflowVersions.executableJson,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, transaction.workspaceId),
        eq(workflowVersions.id, workflowVersionId),
      ),
    );
  const published = result[0];
  if (published === undefined) throw new WebhookDeliveryIneligibleError();
  return Object.freeze(published);
}

/**
 * Locks the verified endpoint and everything that must stay admissible. The statuses
 * are read from the locked rows, so a change that committed during the wait is seen.
 */
export async function lockEligibleEndpoint(
  transaction: WorkspaceTransaction,
  verification: WebhookVerificationReference,
  verifiedSecretVersionId: string,
  { replaying = false }: Readonly<{ replaying?: boolean | undefined }> = {},
): Promise<void> {
  const endpoint = alias(webhookTriggerEndpoints, 'endpoint');
  const workflow = alias(workflows, 'workflow');
  const workspace = alias(workspaces, 'workspace');
  const eligible = await transaction.db
    .select({
      trigger_pause_state: workflow.triggerPauseState,
      published_version_id: workflow.publishedVersionId,
      endpointStatus: endpoint.status,
      workflowLifecycleStatus: workflow.lifecycleStatus,
      workspaceStatus: workspace.status,
    })
    .from(endpoint)
    .innerJoin(
      workflow,
      and(
        eq(workflow.workspaceId, endpoint.workspaceId),
        eq(workflow.id, endpoint.workflowId),
      ),
    )
    .innerJoin(workspace, eq(workspace.id, endpoint.workspaceId))
    .where(
      and(
        eq(endpoint.workspaceId, transaction.workspaceId),
        eq(endpoint.id, verification.endpointId),
        eq(endpoint.endpointKeyHash, verification.endpointKeyHash),
        eq(endpoint.workflowId, verification.workflowId),
        eq(endpoint.nodeId, verification.nodeId),
        sql`${endpoint.authentication}=${JSON.stringify(verification.authentication)}::jsonb`,
        or(
          eq(endpoint.currentSecretVersionId, verifiedSecretVersionId),
          and(
            eq(endpoint.previousSecretVersionId, verifiedSecretVersionId),
            sql`${endpoint.previousSecretValidUntil}>clock_timestamp()`,
          ),
        ),
      ),
    )
    // Workflow before endpoint, the order every trigger command takes them in. The other
    // way round, a delivery between a command's two locks deadlocks with it.
    .for('share', { of: [workflow, endpoint, workspace] });
  const row = eligible[0];
  // A publish that lands after verification leaves this delivery on the version it
  // verified against, as if it had arrived first. Only a removed step refuses it.
  if (
    row === undefined ||
    !endpointTakesDeliveries(row) ||
    !(await stepIsPublished(
      transaction,
      verification,
      row.published_version_id,
    ))
  )
    throw new WebhookDeliveryIneligibleError();
  // ADR 056: the shared workflow lock orders this admission against a pause.
  if (!replaying && row.trigger_pause_state === 'paused')
    throw new WebhookWorkflowPausedError();
}

/**
 * A separate statement on purpose: joined under the row lock above, a publish committing
 * during the wait would re-check this row against the old trigger and refuse a valid delivery.
 */
async function stepIsPublished(
  transaction: WorkspaceTransaction,
  verification: WebhookVerificationReference,
  publishedVersionId: string | null,
): Promise<boolean> {
  if (publishedVersionId === null) return false;
  const published = await transaction.db
    .select({ one: sql`1` })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, transaction.workspaceId),
        eq(workflowTriggers.workflowId, verification.workflowId),
        eq(workflowTriggers.nodeId, verification.nodeId),
        eq(workflowTriggers.workflowVersionId, publishedVersionId),
        eq(workflowTriggers.kind, 'webhook'),
      ),
    );
  return published.length === 1;
}
