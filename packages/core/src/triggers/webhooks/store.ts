import {
  closeEventCoordinationStore,
  createEventCoordinationPreparation,
} from '../coordination/prepare.js';

import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { DEFAULT_INSTANCE_LIMITS } from '../../runs/instance-limits.js';
import type { WebhookResponseScope } from './responses/contract.js';
import { readWebhookResponse } from './responses/records.queries.js';

import { readHealth } from '../reconciliation/health.repository.js';

import {
  authorizeWebhookTriggerReader,
  createWebhookDeliveryLog,
} from './deliveries.repository.js';

import { withTenantScopedClient } from '@pertexo/database/primitives';
import type { WebhookTriggerDatabase } from './runtime/contract.js';

import { acceptVerifiedWebhookDelivery } from './runtime/accept.repository.js';
import { createWorkspaceTurns } from './runtime/workspace-turns.js';
import {
  configureWebhookAuthentication,
  provisionWebhook,
  rotateWebhookEndpoint,
  rotateWebhookSecret,
} from './runtime/management.repository.js';
import {
  consumeWebhookIngressLimit,
  resolveWebhookVerification,
} from './runtime/verification.queries.js';

/**
 * Measured on a loaded machine with the default pool of 5: one acceptance at a
 * time admits 8 deliveries a second, three admit 14, and more add nothing because
 * the admission row lets only one through. Three still leaves other requests two.
 */
const ACCEPTANCES_AT_ONCE_PER_WORKSPACE = 3;
/** Long enough for a burst of 80 at 4 a second, and inside a request's 30 second limit. */
const ACCEPTANCE_MAX_WAIT_MILLIS = 20_000;

export function createWebhookTriggerDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
  {
    burstLimit = DEFAULT_INSTANCE_LIMITS.webhookEndpointBurstLimit,
  }: Readonly<{ burstLimit?: number }> = {},
): WebhookTriggerDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const eventPreparation = createEventCoordinationPreparation();
  const turns = createWorkspaceTurns({
    atOnce: ACCEPTANCES_AT_ONCE_PER_WORKSPACE,
    maxWaitMillis: ACCEPTANCE_MAX_WAIT_MILLIS,
  });

  return Object.freeze({
    readResponse: (input: WebhookResponseScope) => {
      return readWebhookResponse(pool, input);
    },
    configureAuthentication: (
      input: Parameters<WebhookTriggerDatabase['configureAuthentication']>[0],
    ) => configureWebhookAuthentication(pool, input),
    provision: (input: Parameters<WebhookTriggerDatabase['provision']>[0]) =>
      provisionWebhook(pool, input),
    rotateEndpoint: (
      input: Parameters<WebhookTriggerDatabase['rotateEndpoint']>[0],
    ) => rotateWebhookEndpoint(pool, input),
    rotateSecret: (
      input: Parameters<WebhookTriggerDatabase['rotateSecret']>[0],
    ) => rotateWebhookSecret(pool, input),
    getHealth: (input: Parameters<WebhookTriggerDatabase['getHealth']>[0]) => {
      return withTenantScopedClient(
        pool,
        {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
        },
        async (client) => {
          await authorizeWebhookTriggerReader(
            client,
            input.workspaceId,
            input.actorId,
            input.workflowId,
          );
          return readHealth(client, input.workspaceId, input.workflowId);
        },
      );
    },
    resolveVerification: (
      endpointKeyHashInput: Parameters<
        WebhookTriggerDatabase['resolveVerification']
      >[0],
    ) => resolveWebhookVerification(pool, endpointKeyHashInput),
    consumeIngressLimit: (endpointKeyHashInput: string) =>
      consumeWebhookIngressLimit(pool, endpointKeyHashInput, burstLimit),
    acceptVerifiedDelivery: (
      input: Parameters<WebhookTriggerDatabase['acceptVerifiedDelivery']>[0],
    ) =>
      acceptVerifiedWebhookDelivery(pool, { eventPreparation, turns }, input),
    ...createWebhookDeliveryLog(pool),
    close: () =>
      closeEventCoordinationStore(() => lease.close(), eventPreparation),
  });
}
