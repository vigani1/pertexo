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
import type { Pool, PoolClient } from 'pg';

import { endpointTakesDeliveries } from './endpoint.js';
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

export type WebhookIngressCounter = Readonly<{
  bucket_started_at: string;
  request_count: number;
  observed_at: string;
  created: boolean;
}>;

/** Locks the endpoint's ingress counter, creating it if missing. */
export async function lockWebhookIngressCounter(
  client: PoolClient,
  endpointKeyHash: string,
): Promise<WebhookIngressCounter | undefined> {
  const result = await drizzle(client)
    .execute<WebhookIngressCounter>(
      sql`select * from app.lock_webhook_ingress_counter(${endpointKeyHash}::char(64))`,
    )
    .catch(rethrowQueryFailure);
  return result.rows[0];
}

/** False when the counter no longer matches the locked reading. */
export async function storeWebhookIngressCounter(
  client: PoolClient,
  endpointKeyHash: string,
  counter: WebhookIngressCounter,
  next: Readonly<{ reset: boolean; window: string }>,
): Promise<boolean> {
  const { reset, window } = next;
  const changed = await drizzle(client)
    .execute<{ stored: boolean }>(
      sql`select app.store_webhook_ingress_counter(
      ${endpointKeyHash}::char(64),${counter.bucket_started_at}::timestamptz,${counter.request_count},${reset},${window}::timestamptz) stored`,
    )
    .catch(rethrowQueryFailure);
  return changed.rows[0]?.stored === true;
}
