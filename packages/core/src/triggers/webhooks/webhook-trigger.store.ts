import {
  closeEventCoordinationStore,
  createEventCoordinationPreparation,
} from '../coordination/prepare.js';

import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { DEFAULT_WEBHOOK_ENDPOINT_BURST_LIMIT } from '@pertexo/policy';
import type { WebhookResponseScope } from './responses/webhook-response.types.js';
import { readWebhookResponse } from './responses/webhook-responses.repository.js';

import { readHealth } from '../reconciliation/health.repository.js';

import {
  createWebhookDeliveryLog,
  withWebhookReader,
} from './delivery-log.store.js';

import type {
  AcceptVerifiedWebhookDeliveryInput,
  ConfigureWebhookAuthenticationInput,
  ProvisionWebhookInput,
  ReadWebhookHealthInput,
  RotateWebhookEndpointInput,
  RotateWebhookSecretInput,
} from './runtime/webhook-runtime.types.js';

import { acceptVerifiedWebhookDelivery } from './runtime/accept-delivery.js';
import { createWorkspaceTurns } from './runtime/workspace-turns.js';
import {
  configureWebhookAuthentication,
  provisionWebhook,
  rotateWebhookEndpoint,
  rotateWebhookSecret,
} from './runtime/manage-webhook.js';
import { resolveWebhookVerification } from './runtime/verification.repository.js';
import { consumeWebhookIngressLimit } from './runtime/consume-ingress-limit.js';

/**
 * Measured on a loaded machine with the default pool of 5: one acceptance at a
 * time admits 8 deliveries a second, three admit 14, and more add nothing because
 * the admission row lets only one through. Three still leaves other requests two.
 */
const ACCEPTANCES_AT_ONCE_PER_WORKSPACE = 3;
/** Long enough for a burst of 80 at 4 a second, and inside a request's 30 second limit. */
const ACCEPTANCE_MAX_WAIT_MILLIS = 20_000;
/**
 * That burst of 80, and no more: a waiter further back could not be served
 * within the wait at that rate, and each one holds its request in memory.
 */
const ACCEPTANCES_WAITING_PER_WORKSPACE = 80;

export type WebhookTriggerStore = ReturnType<typeof createWebhookTriggerStore>;

export function createWebhookTriggerStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
  {
    burstLimit = DEFAULT_WEBHOOK_ENDPOINT_BURST_LIMIT,
  }: Readonly<{ burstLimit?: number }> = {},
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const eventPreparation = createEventCoordinationPreparation();
  const turns = createWorkspaceTurns({
    atOnce: ACCEPTANCES_AT_ONCE_PER_WORKSPACE,
    maxWaiting: ACCEPTANCES_WAITING_PER_WORKSPACE,
    maxWaitMillis: ACCEPTANCE_MAX_WAIT_MILLIS,
  });

  return Object.freeze({
    readResponse: (input: WebhookResponseScope) =>
      readWebhookResponse(pool, input),
    configureAuthentication: (input: ConfigureWebhookAuthenticationInput) =>
      configureWebhookAuthentication(pool, input),
    provision: (input: ProvisionWebhookInput) => provisionWebhook(pool, input),
    rotateEndpoint: (input: RotateWebhookEndpointInput) =>
      rotateWebhookEndpoint(pool, input),
    rotateSecret: (input: RotateWebhookSecretInput) =>
      rotateWebhookSecret(pool, input),
    getHealth: (input: ReadWebhookHealthInput) =>
      withWebhookReader(pool, input, (client) =>
        readHealth(client, input.workspaceId, input.workflowId),
      ),
    // From here on the caller is an HTTP sender, not a member: it has proved only that
    // it knows the address, and its signature is what gets checked.
    resolveVerification: (endpointKeyHash: string) =>
      resolveWebhookVerification(pool, endpointKeyHash),
    consumeIngressLimit: (endpointKeyHash: string) =>
      consumeWebhookIngressLimit(pool, endpointKeyHash, burstLimit),
    acceptVerifiedDelivery: (input: AcceptVerifiedWebhookDeliveryInput) =>
      acceptVerifiedWebhookDelivery(pool, { eventPreparation, turns }, input),
    ...createWebhookDeliveryLog(pool),
    close: () =>
      closeEventCoordinationStore(() => lease.close(), eventPreparation),
  });
}
