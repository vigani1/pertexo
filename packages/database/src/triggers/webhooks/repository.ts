import {
  closeEventCoordinationStore,
  createEventCoordinationPreparation,
} from '../coordination/prepare.js';

import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { WebhookResponseScope } from './responses/contract.js';
import { readWebhookResponse } from './responses/records.queries.js';

import type { DatabaseConfig } from '../../config.js';
import { DEFAULT_INSTANCE_LIMITS } from '../../runs/capacity/instance-limits.js';

import { readHealth } from '../reconciliation/health.repository.js';

import {
  authorizeWebhookTriggerReader,
  createWebhookDeliveryLog,
} from './deliveries.repository.js';

import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import type { WebhookTriggerDatabase } from './runtime/contract.js';

import { acceptVerifiedWebhookDelivery } from './runtime/accept.repository.js';
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
    ) => acceptVerifiedWebhookDelivery(pool, eventPreparation, input),
    ...createWebhookDeliveryLog(pool),
    close: () =>
      closeEventCoordinationStore(() => lease.close(), eventPreparation),
  });
}
