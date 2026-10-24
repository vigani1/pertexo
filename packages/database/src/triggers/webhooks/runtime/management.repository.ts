import type { WebhookAuthentication } from '@pertexo/contracts';

import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import { sha256HexSchema as digestSchema } from '../../../platform/persisted-primitives.js';

import { refreshWorkflowActivation } from '../../reconciliation/repository.js';

import {
  WebhookTriggerNotFoundError,
  WebhookTriggerStateError,
} from '../errors.js';

import { uuidSchema, type WebhookTriggerDatabase } from './contract.js';
import {
  claimWebhookCommand,
  completeWebhookCommand,
  insertSecret,
} from './receipts.repository.js';
import { oneHealth } from './state.queries.js';
import { command } from './commands.js';

export function configureWebhookAuthentication(
  pool: Pool,
  input: Parameters<WebhookTriggerDatabase['configureAuthentication']>[0],
): ReturnType<WebhookTriggerDatabase['configureAuthentication']> {
  return command(pool, input, async (client) => {
    const operation = 'webhook.trigger.authentication.configure';
    if (await claimWebhookCommand(client, input, operation))
      return {
        trigger: await oneHealth(client, input.workspaceId, input.triggerId),
        replayed: true,
        rotated: false,
      };
    const result = await client.query<{
      authentication: WebhookAuthentication;
    }>(
      `select authentication from app.webhook_trigger_endpoints
            where workspace_id=$1 and trigger_id=$2 and status='active' for update`,
      [input.workspaceId, input.triggerId],
    );
    const current = result.rows[0]?.authentication;
    if (current === undefined) throw new WebhookTriggerNotFoundError();
    const next = input.authentication;
    const rotated =
      current.mode !== next.mode ||
      (current.mode === 'header_secret' &&
        next.mode === 'header_secret' &&
        current.headerName !== next.headerName);
    if (rotated) {
      const secret = await insertSecret(client, input, input.secret);
      await client.query(
        `update app.webhook_trigger_endpoints
            set authentication=$3,endpoint_key_hash=$4,current_secret_version_id=$5,
                previous_secret_version_id=null,previous_secret_valid_until=null,updated_at=clock_timestamp()
            where workspace_id=$1 and trigger_id=$2`,
        [
          input.workspaceId,
          input.triggerId,
          JSON.stringify(next),
          input.endpointKeyHash,
          secret.id,
        ],
      );
    } else {
      await client.query(
        `update app.webhook_trigger_endpoints set authentication=$3,updated_at=clock_timestamp()
            where workspace_id=$1 and trigger_id=$2`,
        [input.workspaceId, input.triggerId, JSON.stringify(next)],
      );
    }
    await completeWebhookCommand(client, input, operation);
    return {
      trigger: await oneHealth(client, input.workspaceId, input.triggerId),
      replayed: false,
      rotated,
    };
  });
}

export function provisionWebhook(
  pool: Pool,
  input: Parameters<WebhookTriggerDatabase['provision']>[0],
): ReturnType<WebhookTriggerDatabase['provision']> {
  return command(pool, input, async (client) => {
    const operation = 'webhook.trigger.provision';
    if (await claimWebhookCommand(client, input, operation))
      return oneHealth(client, input.workspaceId, input.triggerId);
    const trigger = await client.query<{
      workflow_id: string;
      status: string;
    }>(
      `select workflow_id,status from app.workflow_triggers where workspace_id=$1 and id=$2
             and kind='webhook' for update`,
      [input.workspaceId, uuidSchema.parse(input.triggerId)],
    );
    const row = trigger.rows[0];
    if (row === undefined) throw new WebhookTriggerNotFoundError();
    const status = row.status;
    if (status === 'desired' || status === 'pending')
      throw new WebhookTriggerStateError('setting_up');
    if (status === 'active' || status === 'degraded')
      throw new WebhookTriggerStateError('provisioned');
    if (status !== 'configuration_required')
      throw new WebhookTriggerStateError('unavailable');
    const secret = await insertSecret(client, input, input.secret);
    await client.query(
      `insert into app.webhook_trigger_endpoints
            (id,workspace_id,trigger_id,endpoint_key_hash,current_secret_version_id)
           values($1,$2,$3,$4,$5)`,
      [
        uuidSchema.parse(input.endpointId),
        input.workspaceId,
        input.triggerId,
        digestSchema.parse(input.endpointKeyHash),
        secret.id,
      ],
    );
    await client.query(
      `update app.workflow_triggers set status='active',health_status='healthy',
             reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2`,
      [input.workspaceId, input.triggerId],
    );
    await refreshWorkflowActivation(client, input.workspaceId, row.workflow_id);
    await completeWebhookCommand(client, input, operation);
    return oneHealth(client, input.workspaceId, input.triggerId);
  });
}

export function rotateWebhookEndpoint(
  pool: Pool,
  input: Parameters<WebhookTriggerDatabase['rotateEndpoint']>[0],
): ReturnType<WebhookTriggerDatabase['rotateEndpoint']> {
  return command(pool, input, async (client) => {
    const operation = 'webhook.trigger.endpoint.rotate';
    if (await claimWebhookCommand(client, input, operation))
      return oneHealth(client, input.workspaceId, input.triggerId);
    const result = await client.query(
      `update app.webhook_trigger_endpoints set endpoint_key_hash=$3,updated_at=clock_timestamp()
            where workspace_id=$1 and trigger_id=$2 and status='active'`,
      [
        input.workspaceId,
        input.triggerId,
        digestSchema.parse(input.endpointKeyHash),
      ],
    );
    if (result.rowCount !== 1) throw new WebhookTriggerNotFoundError();
    await completeWebhookCommand(client, input, operation);
    return oneHealth(client, input.workspaceId, input.triggerId);
  });
}

export function rotateWebhookSecret(
  pool: Pool,
  input: Parameters<WebhookTriggerDatabase['rotateSecret']>[0],
): ReturnType<WebhookTriggerDatabase['rotateSecret']> {
  return command(pool, input, async (client) => {
    const operation = 'webhook.trigger.secret.rotate';
    const keyedCommand = {
      ...input,
      requestHash: createHash('sha256')
        .update(`${input.requestHash}\0${input.endpointKeyHash}`)
        .digest('hex'),
    };
    if (await claimWebhookCommand(client, keyedCommand, operation))
      return oneHealth(client, input.workspaceId, input.triggerId);
    const endpoint = await client.query<{
      current_secret_version_id: string;
      authentication: WebhookAuthentication;
    }>(
      `select current_secret_version_id,authentication from app.webhook_trigger_endpoints
             where workspace_id=$1 and trigger_id=$2 and endpoint_key_hash=$3
               and status='active' for update`,
      [
        input.workspaceId,
        input.triggerId,
        digestSchema.parse(input.endpointKeyHash),
      ],
    );
    const row = endpoint.rows[0];
    if (row === undefined || row.authentication.mode === 'secret_url')
      throw new WebhookTriggerNotFoundError();
    const current = row.current_secret_version_id;
    const secret = await insertSecret(client, input, input.secret);
    await client.query(
      `update app.webhook_trigger_endpoints set current_secret_version_id=$3,
             previous_secret_version_id=$4,
             previous_secret_valid_until=clock_timestamp()+interval '5 minutes',
             updated_at=clock_timestamp() where workspace_id=$1 and trigger_id=$2`,
      [input.workspaceId, input.triggerId, secret.id, current],
    );
    await completeWebhookCommand(client, keyedCommand, operation);
    return oneHealth(client, input.workspaceId, input.triggerId);
  });
}
