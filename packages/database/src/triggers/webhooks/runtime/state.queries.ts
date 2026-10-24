import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowVersions,
  workflowTriggers,
} from '../../../schema/authoring/workflows.js';
import { workspaces } from '../../../schema/foundation.js';
import { webhookTriggerEndpoints } from '../../../schema/triggers/endpoints.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';

import type { PublishedWorkflow } from '../../../runs/queries/execution/published.js';
import { readHealth } from '../../reconciliation/health.repository.js';
import type { WorkflowTriggerHealth } from '../../reconciliation/contract.js';

import {
  WebhookDeliveryIneligibleError,
  WebhookTriggerNotFoundError,
  WebhookWorkflowPausedError,
} from '../errors.js';
import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';
import type { WebhookVerificationReference } from './contract.js';

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

/** Locks the verified endpoint and everything that must stay admissible. */
export async function lockEligibleEndpoint(
  transaction: WorkspaceTransaction,
  verification: WebhookVerificationReference,
  verifiedSecretVersionId: string,
  { replaying = false }: Readonly<{ replaying?: boolean | undefined }> = {},
): Promise<void> {
  const endpoint = alias(webhookTriggerEndpoints, 'endpoint');
  const trigger = alias(workflowTriggers, 'trigger');
  const workflow = alias(workflows, 'workflow');
  const workspace = alias(workspaces, 'workspace');
  const eligible = await transaction.db
    .select({
      workflow_version_id: trigger.workflowVersionId,
      trigger_pause_state: workflow.triggerPauseState,
    })
    .from(endpoint)
    .innerJoin(
      trigger,
      and(
        eq(trigger.workspaceId, endpoint.workspaceId),
        eq(trigger.id, endpoint.triggerId),
      ),
    )
    .innerJoin(
      workflow,
      and(
        eq(workflow.workspaceId, trigger.workspaceId),
        eq(workflow.id, trigger.workflowId),
      ),
    )
    .innerJoin(workspace, eq(workspace.id, trigger.workspaceId))
    .where(
      and(
        eq(endpoint.workspaceId, transaction.workspaceId),
        eq(endpoint.id, verification.endpointId),
        eq(endpoint.endpointKeyHash, verification.endpointKeyHash),
        eq(endpoint.triggerId, verification.triggerId),
        sql`${endpoint.authentication}=${JSON.stringify(verification.authentication)}::jsonb`,
        eq(endpoint.status, 'active'),
        eq(trigger.status, 'active'),
        eq(trigger.workflowId, verification.workflowId),
        eq(trigger.workflowVersionId, verification.workflowVersionId),
        eq(workflow.publishedVersionId, trigger.workflowVersionId),
        eq(workflow.lifecycleStatus, 'active'),
        inArray(workflow.activationStatus, ['active', 'degraded']),
        eq(workspace.status, 'active'),
        or(
          eq(endpoint.currentSecretVersionId, verifiedSecretVersionId),
          and(
            eq(endpoint.previousSecretVersionId, verifiedSecretVersionId),
            sql`${endpoint.previousSecretValidUntil}>clock_timestamp()`,
          ),
        ),
      ),
    )
    .for('share', { of: [endpoint, trigger, workflow, workspace] });
  const row = eligible[0];
  if (row === undefined) throw new WebhookDeliveryIneligibleError();
  // ADR 056: the shared workflow lock orders this admission against a pause.
  if (!replaying && row.trigger_pause_state === 'paused')
    throw new WebhookWorkflowPausedError();
}
