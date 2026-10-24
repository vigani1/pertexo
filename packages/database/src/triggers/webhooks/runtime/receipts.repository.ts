import { drizzle } from 'drizzle-orm/node-postgres';
import { webhookTriggerSecretVersions as secrets } from '../../../schema/triggers/endpoints.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { appendAuditFact } from '../../../governance/audit/events.repository.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as digestSchema } from '../../../platform/persisted-primitives.js';

import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';

import { WebhookTriggerIdempotencyConflictError } from '../errors.js';

import {
  sealedSchema,
  type SealedWebhookTriggerSecret,
  type Command,
} from './contract.js';

function webhookCommand(input: Command, operation: string) {
  return {
    workspaceId: input.workspaceId,
    operation,
    scope: `${input.actorId}:${input.workflowId}:${input.triggerId}`,
    idempotencyKey: z.string().min(1).max(128).parse(input.idempotencyKey),
    requestHash: digestSchema.parse(input.requestHash),
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
  secretInput: SealedWebhookTriggerSecret,
): Promise<z.output<typeof sealedSchema>> {
  const secret = sealedSchema.parse(secretInput);
  await drizzle(client)
    .insert(secrets)
    .values({
      id: secret.id,
      workspaceId: input.workspaceId,
      triggerId: input.triggerId,
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
