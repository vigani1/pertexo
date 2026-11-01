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

import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';

import { WebhookIngressRateLimitExceededError } from '../errors.js';
import type {
  StoredWebhookTriggerSecret,
  WebhookConfig,
  WebhookTriggerDatabase,
} from './contract.js';

export async function resolveWebhookVerification(
  pool: Pool,
  endpointKeyHash: Parameters<WebhookTriggerDatabase['resolveVerification']>[0],
): ReturnType<WebhookTriggerDatabase['resolveVerification']> {
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
  if (row === undefined) return null;
  const { workspaceId, triggerId, workflowVersionId } = row;
  const config = await withWorkspaceReadTransaction(
    pool,
    workspaceId,
    async (transaction) => {
      const result = await transaction.db
        .select({
          desiredConfig: sql<WebhookConfig>`${workflowTriggers.desiredConfig}`,
        })
        .from(workflowTriggers)
        .where(
          and(
            eq(workflowTriggers.workspaceId, workspaceId),
            eq(workflowTriggers.id, triggerId),
            eq(workflowTriggers.workflowVersionId, workflowVersionId),
          ),
        );
      return result[0]?.desiredConfig;
    },
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
  endpointKeyHashInput: Parameters<
    WebhookTriggerDatabase['consumeIngressLimit']
  >[0],
  burstLimit: number,
): ReturnType<WebhookTriggerDatabase['consumeIngressLimit']> {
  const result = await drizzle(pool)
    .execute<{ allowed: boolean; retry_after_seconds: number }>(
      sql`select * from app.consume_webhook_ingress_limit(${endpointKeyHashInput}::char(64),${burstLimit}::integer)`,
    )
    .catch(rethrowQueryFailure);
  const decision = result.rows[0];
  if (decision === undefined)
    throw new Error('Webhook ingress decision is unavailable');
  if (!decision.allowed)
    throw new WebhookIngressRateLimitExceededError(
      decision.retry_after_seconds,
    );
}
