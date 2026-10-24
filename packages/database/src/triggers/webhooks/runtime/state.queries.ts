import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  parsePublishedWorkflowRow,
  type PublishedWorkflow,
} from '../../../runs/queries/execution/published.js';
import {
  readHealth,
  type WorkflowTriggerHealth,
} from '../../reconciliation/repository.js';

import {
  WebhookDeliveryIneligibleError,
  WebhookTriggerNotFoundError,
  WebhookWorkflowPausedError,
} from '../errors.js';
import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';
import {
  uuidSchema,
  type SealedWebhookTriggerSecret,
  type WebhookVerificationReference,
} from './contract.js';

export async function oneHealth(
  client: PoolClient,
  workspaceId: string,
  triggerId: string,
): Promise<WorkflowTriggerHealth> {
  const identity = await client.query<{ workflow_id: string }>(
    'select workflow_id from app.workflow_triggers where workspace_id=$1 and id=$2',
    [workspaceId, triggerId],
  );
  const workflowId = identity.rows[0]?.workflow_id;
  if (workflowId === undefined) throw new WebhookTriggerNotFoundError();
  const health = await readHealth(client, workspaceId, workflowId);
  const trigger = health.find(({ id }) => id === triggerId);
  if (trigger === undefined) throw new WebhookTriggerNotFoundError();
  return trigger;
}

export function mapSecret(
  row: Record<string, unknown>,
  prefix: 'current' | 'previous',
): SealedWebhookTriggerSecret | undefined {
  if (row[`${prefix}_secret_version_id`] == null) return undefined;
  return Object.freeze({
    id: uuidSchema.parse(row[`${prefix}_secret_version_id`]),
    kmsKeyReference: z.string().parse(row[`${prefix}_kms_key_reference`]),
    encryptedDataKey: z.string().parse(row[`${prefix}_encrypted_data_key`]),
    ciphertext: z.string().parse(row[`${prefix}_ciphertext`]),
    nonce: z.string().parse(row[`${prefix}_nonce`]),
    authTag: z.string().parse(row[`${prefix}_auth_tag`]),
  });
}

export async function executableProjection(
  transaction: WorkspaceTransaction,
  workflowVersionId: string,
): Promise<PublishedWorkflow> {
  const result = await transaction.db.execute(sql<Record<string, unknown>>`
    select id,workspace_id,workflow_id,version_number,checksum,
           executable_json
      from app.workflow_versions where workspace_id=${transaction.workspaceId}
       and id=${workflowVersionId}
  `);
  const published = parsePublishedWorkflowRow(result.rows[0]);
  if (published === null) throw new WebhookDeliveryIneligibleError();
  return published;
}

/** Locks the verified endpoint and everything that must stay admissible. */
export async function lockEligibleEndpoint(
  transaction: WorkspaceTransaction,
  verification: WebhookVerificationReference,
  verifiedSecretVersionId: string,
  { replaying = false }: Readonly<{ replaying?: boolean | undefined }> = {},
): Promise<void> {
  const eligible = await transaction.db.execute<{
    workflow_version_id: string;
    trigger_pause_state: string;
  }>(sql`
    select trigger.workflow_version_id,workflow.trigger_pause_state
      from app.webhook_trigger_endpoints endpoint
      join app.workflow_triggers trigger on trigger.workspace_id=endpoint.workspace_id
       and trigger.id=endpoint.trigger_id
      join app.workflows workflow on workflow.workspace_id=trigger.workspace_id
       and workflow.id=trigger.workflow_id
      join app.workspaces workspace on workspace.id=trigger.workspace_id
     where endpoint.workspace_id=${transaction.workspaceId}
       and endpoint.id=${verification.endpointId}
       and endpoint.endpoint_key_hash=${verification.endpointKeyHash}
       and endpoint.trigger_id=${verification.triggerId}
       and endpoint.authentication=${JSON.stringify(verification.authentication)}::jsonb
       and endpoint.status='active' and trigger.status='active'
       and trigger.workflow_id=${verification.workflowId}
       and trigger.workflow_version_id=${verification.workflowVersionId}
       and workflow.published_version_id=trigger.workflow_version_id
       and workflow.lifecycle_status='active'
       and workflow.activation_status in ('active','degraded')
       and workspace.status='active'
       and (endpoint.current_secret_version_id=${verifiedSecretVersionId}
         or (endpoint.previous_secret_version_id=${verifiedSecretVersionId}
           and endpoint.previous_secret_valid_until>clock_timestamp()))
     for share of endpoint,trigger,workflow,workspace
  `);
  const row = eligible.rows[0];
  if (row === undefined) throw new WebhookDeliveryIneligibleError();
  // ADR 056: the shared workflow lock orders this admission against a pause.
  if (!replaying && row.trigger_pause_state === 'paused')
    throw new WebhookWorkflowPausedError();
}
