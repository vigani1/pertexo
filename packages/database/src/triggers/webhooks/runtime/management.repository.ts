import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { workflowTriggers } from '../../../schema/authoring/workflows.js';
import { webhookTriggerEndpoints as endpoints } from '../../../schema/triggers/endpoints.js';

import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import { refreshWorkflowActivation } from '../../reconciliation/health.repository.js';

import {
  WebhookTriggerNotFoundError,
  WebhookTriggerStateError,
} from '../errors.js';

import { command } from './commands.js';
import type { WebhookTriggerDatabase } from './contract.js';
import {
  claimWebhookCommand,
  completeWebhookCommand,
  insertSecret,
} from './receipts.repository.js';
import { oneHealth } from './state.queries.js';

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
    const db = drizzle(client);
    const result = await db
      .select({ authentication: endpoints.authentication })
      .from(endpoints)
      .where(
        and(
          eq(endpoints.workspaceId, input.workspaceId),
          eq(endpoints.triggerId, input.triggerId),
          eq(endpoints.status, 'active'),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    const current = result[0]?.authentication;
    if (current === undefined) throw new WebhookTriggerNotFoundError();
    const next = input.authentication;
    const rotated =
      current.mode !== next.mode ||
      (current.mode === 'header_secret' &&
        next.mode === 'header_secret' &&
        current.headerName !== next.headerName);
    if (rotated) {
      const secret = await insertSecret(client, input, input.secret);
      await db
        .update(endpoints)
        .set({
          authentication: next,
          endpointKeyHash: input.endpointKeyHash,
          currentSecretVersionId: secret.id,
          previousSecretVersionId: null,
          previousSecretValidUntil: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(endpoints.workspaceId, input.workspaceId),
            eq(endpoints.triggerId, input.triggerId),
          ),
        )
        .catch(rethrowQueryFailure);
    } else {
      await db
        .update(endpoints)
        .set({ authentication: next, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(endpoints.workspaceId, input.workspaceId),
            eq(endpoints.triggerId, input.triggerId),
          ),
        )
        .catch(rethrowQueryFailure);
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
      return {
        trigger: await oneHealth(client, input.workspaceId, input.triggerId),
        replayed: true,
      };
    const db = drizzle(client);
    const trigger = await db
      .select({
        workflow_id: workflowTriggers.workflowId,
        status: workflowTriggers.status,
      })
      .from(workflowTriggers)
      .where(
        and(
          eq(workflowTriggers.workspaceId, input.workspaceId),
          eq(workflowTriggers.id, input.triggerId),
          eq(workflowTriggers.kind, 'webhook'),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    const row = trigger[0];
    if (row === undefined) throw new WebhookTriggerNotFoundError();
    const status = row.status;
    if (status === 'desired' || status === 'pending')
      throw new WebhookTriggerStateError('setting_up');
    if (status === 'active' || status === 'degraded')
      throw new WebhookTriggerStateError('provisioned');
    if (status !== 'configuration_required')
      throw new WebhookTriggerStateError('unavailable');
    const secret = await insertSecret(client, input, input.secret);
    await db
      .insert(endpoints)
      .values({
        id: input.endpointId,
        workspaceId: input.workspaceId,
        triggerId: input.triggerId,
        endpointKeyHash: input.endpointKeyHash,
        currentSecretVersionId: secret.id,
      })
      .catch(rethrowQueryFailure);
    await db
      .update(workflowTriggers)
      .set({
        status: 'active',
        healthStatus: 'healthy',
        reconciledAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(workflowTriggers.workspaceId, input.workspaceId),
          eq(workflowTriggers.id, input.triggerId),
        ),
      )
      .catch(rethrowQueryFailure);
    await refreshWorkflowActivation(client, input.workspaceId, row.workflow_id);
    await completeWebhookCommand(client, input, operation);
    return {
      trigger: await oneHealth(client, input.workspaceId, input.triggerId),
      replayed: false,
    };
  });
}

export function rotateWebhookEndpoint(
  pool: Pool,
  input: Parameters<WebhookTriggerDatabase['rotateEndpoint']>[0],
): ReturnType<WebhookTriggerDatabase['rotateEndpoint']> {
  return command(pool, input, async (client) => {
    const operation = 'webhook.trigger.endpoint.rotate';
    if (await claimWebhookCommand(client, input, operation))
      return {
        trigger: await oneHealth(client, input.workspaceId, input.triggerId),
        replayed: true,
      };
    const result = await drizzle(client)
      .update(endpoints)
      .set({
        endpointKeyHash: input.endpointKeyHash,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(endpoints.workspaceId, input.workspaceId),
          eq(endpoints.triggerId, input.triggerId),
          eq(endpoints.status, 'active'),
        ),
      )
      .returning({ id: endpoints.id })
      .catch(rethrowQueryFailure);
    if (result.length !== 1) throw new WebhookTriggerNotFoundError();
    await completeWebhookCommand(client, input, operation);
    return {
      trigger: await oneHealth(client, input.workspaceId, input.triggerId),
      replayed: false,
    };
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
      return {
        trigger: await oneHealth(client, input.workspaceId, input.triggerId),
        replayed: true,
      };
    const db = drizzle(client);
    const endpoint = await db
      .select({
        current_secret_version_id: endpoints.currentSecretVersionId,
        authentication: endpoints.authentication,
      })
      .from(endpoints)
      .where(
        and(
          eq(endpoints.workspaceId, input.workspaceId),
          eq(endpoints.triggerId, input.triggerId),
          eq(endpoints.endpointKeyHash, input.endpointKeyHash),
          eq(endpoints.status, 'active'),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    const row = endpoint[0];
    if (row === undefined || row.authentication.mode === 'secret_url')
      throw new WebhookTriggerNotFoundError();
    const current = row.current_secret_version_id;
    const secret = await insertSecret(client, input, input.secret);
    await db
      .update(endpoints)
      .set({
        currentSecretVersionId: secret.id,
        previousSecretVersionId: current,
        previousSecretValidUntil: sql`clock_timestamp()+interval '5 minutes'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(endpoints.workspaceId, input.workspaceId),
          eq(endpoints.triggerId, input.triggerId),
        ),
      )
      .catch(rethrowQueryFailure);
    await completeWebhookCommand(client, keyedCommand, operation);
    return {
      trigger: await oneHealth(client, input.workspaceId, input.triggerId),
      replayed: false,
    };
  });
}
