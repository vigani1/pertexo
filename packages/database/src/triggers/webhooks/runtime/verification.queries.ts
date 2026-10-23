import type { WebhookAuthentication } from '@pertexo/contracts';

import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as digestSchema } from '../../../platform/persisted-primitives.js';

import { WebhookIngressRateLimitExceededError } from '../errors.js';
import { withWorkspaceReadTransaction } from '../../../tenant-access/transactions.js';
import {
  uuidSchema,
  type WebhookConfig,
  type WebhookTriggerDatabase,
} from './contract.js';

import { mapSecret } from './state.queries.js';

export async function resolveWebhookVerification(
  pool: Pool,
  endpointKeyHashInput: Parameters<
    WebhookTriggerDatabase['resolveVerification']
  >[0],
): ReturnType<WebhookTriggerDatabase['resolveVerification']> {
  const endpointKeyHash = digestSchema.parse(endpointKeyHashInput);
  const result = await pool.query<
    Record<string, unknown> & { authentication: WebhookAuthentication }
  >('select * from app.resolve_public_webhook_endpoint($1::char(64))', [
    endpointKeyHash,
  ]);
  const row = result.rows[0];
  if (row === undefined) return null;
  const currentSecret = mapSecret(row, 'current');
  if (currentSecret === undefined) return null;
  const previousSecret = mapSecret(row, 'previous');
  const workspaceId = uuidSchema.parse(row.workspace_id);
  const triggerId = uuidSchema.parse(row.trigger_id);
  const workflowVersionId = uuidSchema.parse(row.workflow_version_id);
  const config = await withWorkspaceReadTransaction(
    pool,
    workspaceId,
    async (transaction) => {
      const result = await transaction.db.execute<{
        desired_config: WebhookConfig;
      }>(
        sql`select desired_config from app.workflow_triggers where workspace_id=${transaction.workspaceId} and id=${triggerId} and workflow_version_id=${workflowVersionId}`,
      );
      return result.rows[0]?.desired_config;
    },
  );
  return Object.freeze({
    endpointId: uuidSchema.parse(row.endpoint_id),
    endpointKeyHash,
    workspaceId: uuidSchema.parse(row.workspace_id),
    triggerId: uuidSchema.parse(row.trigger_id),
    workflowId: uuidSchema.parse(row.workflow_id),
    workflowVersionId: uuidSchema.parse(row.workflow_version_id),
    nodeId: z.string().parse(row.node_id),
    databaseTime: z.date().parse(row.database_time),
    authentication: row.authentication,
    ...(config?.runInput === undefined
      ? {}
      : { runInputMode: config.runInput }),
    currentSecret,
    ...(previousSecret === undefined
      ? {}
      : {
          previousSecret: Object.freeze({
            ...previousSecret,
            validUntil: z.date().parse(row.previous_secret_valid_until),
          }),
        }),
  });
}

export async function consumeWebhookIngressLimit(
  pool: Pool,
  endpointKeyHashInput: Parameters<
    WebhookTriggerDatabase['consumeIngressLimit']
  >[0],
): ReturnType<WebhookTriggerDatabase['consumeIngressLimit']> {
  const result = await pool.query<{
    allowed: boolean;
    retry_after_seconds: number;
  }>('select * from app.consume_webhook_ingress_limit($1::char(64))', [
    digestSchema.parse(endpointKeyHashInput),
  ]);
  const decision = result.rows[0];
  if (decision?.allowed !== true)
    throw new WebhookIngressRateLimitExceededError(
      z.number().int().min(1).max(60).parse(decision?.retry_after_seconds),
    );
}
