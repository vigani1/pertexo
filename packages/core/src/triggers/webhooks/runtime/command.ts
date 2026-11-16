import { credentialCommandScope } from '@pertexo/database/platform';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import type { PoolClient } from 'pg';
import { WebhookTriggerIdempotencyConflictError } from '../webhook-trigger.errors.js';
import type { Command } from './webhook-runtime.types.js';

function webhookCommand(input: Command, operation: string) {
  return {
    workspaceId: input.workspaceId,
    operation,
    scope: credentialCommandScope(
      `${input.actorId}:${input.workflowId}:${input.triggerId}`,
      input.commandCredentialId,
    ),
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    conflict: () => new WebhookTriggerIdempotencyConflictError(),
  };
}

/** Claims the command's key; true when an exact retry already completed it. */
export async function claimWebhookCommand(
  client: PoolClient,
  input: Command,
  operation: string,
): Promise<boolean> {
  const stored = await claimCommand(client, {
    ...webhookCommand(input, operation),
    resourceId: input.triggerId,
  });
  return stored !== null;
}

export async function completeWebhookCommand(
  client: PoolClient,
  input: Command,
  operation: string,
): Promise<void> {
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: operation,
    targetType: 'webhook_trigger',
    targetId: input.triggerId,
    metadata: { workflowId: input.workflowId },
  });
  await completeCommand(client, webhookCommand(input, operation), {
    triggerId: input.triggerId,
  });
}
