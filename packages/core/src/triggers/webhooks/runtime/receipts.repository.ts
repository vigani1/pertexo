import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowTriggers,
  webhookTriggerSecretVersions as secrets,
} from '@pertexo/database/schema';

import type { PoolClient } from 'pg';

import type {
  Command,
  SealedWebhookTriggerSecret,
} from './webhook-runtime.types.js';

/** Stores the trigger's secret; undefined, with nothing stored, when the trigger is gone. */
export async function insertSecret(
  client: PoolClient,
  input: Command,
  secret: SealedWebhookTriggerSecret,
): Promise<
  | {
      id: string;
      kmsKeyReference: string;
      encryptedDataKey: string;
      ciphertext: string;
      nonce: string;
      authTag: string;
    }
  | undefined
> {
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
  if (trigger === undefined) return undefined;
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
