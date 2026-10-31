import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { appendAuditFact } from '../../../governance/audit/events.repository.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { workflowTriggers } from '../../../schema/authoring/workflows.js';
import { webhookTriggerSecretVersions as secrets } from '../../../schema/triggers/endpoints.js';

import type { PoolClient } from 'pg';

import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';

import {
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
} from '../errors.js';

import type { Command, SealedWebhookTriggerSecret } from './contract.js';

function webhookCommand(input: Command, operation: string) {
  return {
    workspaceId: input.workspaceId,
    operation,
    scope: `${input.actorId}:${input.workflowId}:${input.triggerId}`,
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

export async function insertSecret(
  client: PoolClient,
  input: Command,
  secret: SealedWebhookTriggerSecret,
): Promise<{
  id: string;
  kmsKeyReference: string;
  encryptedDataKey: string;
  ciphertext: string;
  nonce: string;
  authTag: string;
}> {
  const db = drizzle(client);
  const [trigger] = await db
    .select({
      workflowId: workflowTriggers.workflowId,
      nodeId: workflowTriggers.nodeId,
    })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, input.workspaceId),
        eq(workflowTriggers.id, input.triggerId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (trigger === undefined) throw new WebhookTriggerNotFoundError();
  await db
    .insert(secrets)
    .values({
      id: secret.id,
      workspaceId: input.workspaceId,
      triggerId: input.triggerId,
      workflowId: trigger.workflowId,
      nodeId: trigger.nodeId,
      purpose: 'webhook_hmac_sha256',
      kmsKeyReference: secret.kmsKeyReference,
      encryptedDataKey: secret.encryptedDataKey,
      ciphertext: secret.ciphertext,
      nonce: secret.nonce,
      authTag: secret.authTag,
      createdBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
  return secret;
}
