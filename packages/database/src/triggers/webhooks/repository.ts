import {
  createEventCoordinationPreparation,
  closeEventCoordinationStore,
} from '../coordination/prepare.js';

import { readWebhookResponse } from './responses/records.queries.js';
import type { WebhookResponseScope } from './responses/contract.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';

import type { DatabaseConfig } from '../../config.js';

import { readHealth } from '../reconciliation/repository.js';

import {
  authorizeWebhookTriggerReader,
  createWebhookDeliveryLog,
} from './deliveries.repository.js';

import {
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
  WebhookTriggerStateError,
  WebhookWorkflowPausedError,
} from './errors.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { uuidSchema, type WebhookTriggerDatabase } from './runtime/contract.js';

import {
  configureWebhookAuthentication,
  provisionWebhook,
  rotateWebhookEndpoint,
  rotateWebhookSecret,
} from './runtime/management.repository.js';
import {
  resolveWebhookVerification,
  consumeWebhookIngressLimit,
} from './runtime/verification.queries.js';
import { acceptVerifiedWebhookDelivery } from './runtime/accept.repository.js';
export {
  WebhookTriggerStateError,
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
  WebhookWorkflowPausedError,
};
export {
  type SealedWebhookTriggerSecret,
  type WebhookVerificationReference,
  type AcceptVerifiedWebhookDeliveryInput,
  type WebhookTriggerDatabase,
} from './runtime/contract.js';

export function createWebhookTriggerDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
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
          workspaceId: uuidSchema.parse(input.workspaceId),
          actorId: uuidSchema.parse(input.actorId),
        },
        async (client) => {
          await authorizeWebhookTriggerReader(
            client,
            input.workspaceId,
            input.actorId,
            input.workflowId,
          );
          return readHealth(
            client,
            input.workspaceId,
            uuidSchema.parse(input.workflowId),
          );
        },
      );
    },
    resolveVerification: (
      endpointKeyHashInput: Parameters<
        WebhookTriggerDatabase['resolveVerification']
      >[0],
    ) => resolveWebhookVerification(pool, endpointKeyHashInput),
    consumeIngressLimit: (endpointKeyHashInput: string) =>
      consumeWebhookIngressLimit(pool, endpointKeyHashInput),
    acceptVerifiedDelivery: (
      input: Parameters<WebhookTriggerDatabase['acceptVerifiedDelivery']>[0],
    ) => acceptVerifiedWebhookDelivery(pool, eventPreparation, input),
    ...createWebhookDeliveryLog(pool),
    close: () =>
      closeEventCoordinationStore(() => lease.close(), eventPreparation),
  });
}
