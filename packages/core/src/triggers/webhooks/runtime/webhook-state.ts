import type { PoolClient } from 'pg';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import type { PublishedWorkflow } from '../../../runs/queries/execution/workflow-execution.types.js';
import { readHealth } from '../../reconciliation/health.repository.js';
import type { WorkflowTriggerHealth } from '../../reconciliation/trigger-reconciliation.types.js';
import {
  WebhookDeliveryIneligibleError,
  WebhookTriggerNotFoundError,
  WebhookWorkflowPausedError,
} from '../webhook-trigger.errors.js';
import type { WebhookVerificationReference } from './webhook-runtime.types.js';
import { endpointTakesDeliveries } from './endpoint-rules.js';
import {
  lockEndpointEligibility,
  readExecutableProjection,
  readTriggerWorkflowId,
  stepIsPublished,
} from './webhook-state.repository.js';

export async function oneHealth(
  client: PoolClient,
  workspaceId: string,
  triggerId: string,
): Promise<WorkflowTriggerHealth> {
  const workflowId = await readTriggerWorkflowId(
    client,
    workspaceId,
    triggerId,
  );
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
  const published = await readExecutableProjection(
    transaction,
    workflowVersionId,
  );
  if (published === undefined) throw new WebhookDeliveryIneligibleError();
  return published;
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
  const row = await lockEndpointEligibility(
    transaction,
    verification,
    verifiedSecretVersionId,
  );
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
