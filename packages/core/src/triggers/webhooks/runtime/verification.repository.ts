import { withPlatformTransaction } from '@pertexo/database/platform';
import type { WebhookAuthentication } from '@pertexo/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  withWorkspaceReadTransaction,
} from '@pertexo/database/primitives';
import {
  workflowTriggers,
  webhookTriggerEndpoints as endpoints,
} from '@pertexo/database/schema';

import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';

import { WebhookIngressRateLimitExceededError } from '../webhook-trigger.errors.js';
import { endpointTakesDeliveries } from './endpoint-rules.js';
import { readTriggerConfig } from './webhook-state.repository.js';
import type {
  StoredWebhookTriggerSecret,
  WebhookVerificationReference,
} from './webhook-runtime.types.js';

export async function resolveWebhookVerification(
  pool: Pool,
  endpointKeyHash: string,
): Promise<WebhookVerificationReference | null> {
  const result = await drizzle(pool)
    .select({
      endpointId: sql<string>`resolution.endpoint_id`,
      workspaceId: sql<string>`resolution.workspace_id`,
      triggerId: sql<string>`resolution.trigger_id`,
      workflowId: sql<string>`resolution.workflow_id`,
      workflowVersionId: sql<string>`resolution.workflow_version_id`,
      nodeId: sql<string>`resolution.node_id`,
      databaseTime: sql<Date>`resolution.database_time`.mapWith(
        workflowTriggers.createdAt,
      ),
      authentication: sql<WebhookAuthentication>`resolution.authentication`,
      endpointStatus: sql<string>`resolution.endpoint_status`,
      workflowLifecycleStatus: sql<string>`resolution.workflow_lifecycle_status`,
      workspaceStatus: sql<string>`resolution.workspace_status`,
      currentSecret: sql<StoredWebhookTriggerSecret>`jsonb_build_object('id',resolution.current_secret_version_id,
      'triggerId',resolution.current_secret_trigger_id,'kmsKeyReference',resolution.current_kms_key_reference,'encryptedDataKey',resolution.current_encrypted_data_key,
      'ciphertext',resolution.current_ciphertext,'nonce',resolution.current_nonce,'authTag',resolution.current_auth_tag)`,
      previousSecret: sql<StoredWebhookTriggerSecret | null>`case when resolution.previous_secret_version_id is null then null
      else jsonb_build_object('id',resolution.previous_secret_version_id,
        'triggerId',resolution.previous_secret_trigger_id,'kmsKeyReference',resolution.previous_kms_key_reference,
        'encryptedDataKey',resolution.previous_encrypted_data_key,'ciphertext',resolution.previous_ciphertext,
        'nonce',resolution.previous_nonce,'authTag',resolution.previous_auth_tag) end`,
      previousSecretValidUntil:
        sql<Date>`resolution.previous_secret_valid_until`.mapWith(
          endpoints.previousSecretValidUntil,
        ),
    })
    .from(
      sql`app.resolve_public_webhook_endpoint(${endpointKeyHash}::char(64)) as resolution`,
    )
    .catch(rethrowQueryFailure);
  const row = result[0];
  if (row === undefined || !endpointTakesDeliveries(row)) return null;
  const { workspaceId, triggerId, workflowVersionId } = row;
  const config = await withWorkspaceReadTransaction(
    pool,
    workspaceId,
    (transaction) =>
      readTriggerConfig(transaction, triggerId, workflowVersionId),
  );
  return Object.freeze({
    endpointId: row.endpointId,
    endpointKeyHash,
    workspaceId,
    triggerId,
    workflowId: row.workflowId,
    workflowVersionId,
    nodeId: row.nodeId,
    databaseTime: row.databaseTime,
    authentication: row.authentication,
    ...(config?.runInput === undefined
      ? {}
      : { runInputMode: config.runInput }),
    currentSecret: Object.freeze(row.currentSecret),
    ...(row.previousSecret === null
      ? {}
      : {
          previousSecret: Object.freeze({
            ...row.previousSecret,
            validUntil: row.previousSecretValidUntil,
          }),
        }),
  });
}

export async function consumeWebhookIngressLimit(
  pool: Pool,
  endpointKeyHashInput: string,
  burstLimit: number,
): Promise<void> {
  const retryAfter = await withPlatformTransaction(pool, async (client) => {
    const db = drizzle(client);
    const result = await db
      .execute<{
        bucket_started_at: string;
        request_count: number;
        observed_at: string;
        created: boolean;
      }>(
        sql`select * from app.lock_webhook_ingress_counter(${endpointKeyHashInput}::char(64))`,
      )
      .catch(rethrowQueryFailure);
    const counter = result.rows[0];
    if (counter === undefined) return 1;
    const remainingMillis =
      Date.parse(counter.bucket_started_at) +
      60_000 -
      Date.parse(counter.observed_at);
    const reset = counter.created || remainingMillis <= 0;
    if (!reset && counter.request_count >= burstLimit)
      return Math.max(1, Math.min(60, Math.ceil(remainingMillis / 1_000)));
    const window = reset ? counter.observed_at : counter.bucket_started_at;
    const changed = await db
      .execute<{ stored: boolean }>(
        sql`select app.store_webhook_ingress_counter(
      ${endpointKeyHashInput}::char(64),${counter.bucket_started_at}::timestamptz,${counter.request_count},${reset},${window}::timestamptz) stored`,
      )
      .catch(rethrowQueryFailure);
    if (changed.rows[0]?.stored !== true)
      throw new Error('Webhook ingress counter ownership changed');
    return 0;
  });
  if (retryAfter > 0)
    throw new WebhookIngressRateLimitExceededError(retryAfter);
}
