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
  await client.query(
    `insert into app.webhook_trigger_secret_versions
      (id,workspace_id,trigger_id,purpose,kms_key_reference,
       encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
     values($1,$2,$3,'webhook_hmac_sha256',$4,$5,$6,$7,$8,$9)`,
    [
      secret.id,
      input.workspaceId,
      input.triggerId,
      secret.kmsKeyReference,
      secret.encryptedDataKey,
      secret.ciphertext,
      secret.nonce,
      secret.authTag,
      input.actorId,
    ],
  );
  return secret;
}
