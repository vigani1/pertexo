import {
  createWebhookTestEventStore,
  createWebhookTriggerStore,
} from '@pertexo/core/triggers';
import { initialCheckpointFactory } from '@pertexo/core/execution';
import {
  WebhookTriggerEnvelopeEncryption,
  type WebhookTriggerSecretContext,
} from '@pertexo/integrations/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import type { ApiConfig } from '../../../src/platform/config/api.js';
import type { ApiWebhookRuntime } from '../../../src/platform/webhooks/runtime.module.js';
import { WebhookManagementService } from '../../../src/webhooks/management/service.js';
import { WebhookTestEventService } from '../../../src/webhooks/test-events/service.js';
import { createEditorBrowserEnvelopeKeys } from '../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { silentLogger } from '../../support/silent-logger.js';

/** Real stores and services, with test-owned authenticated wrapping instead of AWS KMS. */
export function createEditorWebhookRuntime(
  databaseConfig: ApiConfig['database'],
  masterKey: Uint8Array,
): Promise<ApiWebhookRuntime> {
  const keys = createEditorBrowserEnvelopeKeys<WebhookTriggerSecretContext>(
    masterKey,
    'webhook',
  );
  const encryption = new WebhookTriggerEnvelopeEncryption(keys);
  const database = createWebhookTriggerStore(databaseConfig);
  const testEvents = createWebhookTestEventStore(databaseConfig);
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  return Promise.resolve(
    Object.freeze({
      service: new WebhookManagementService(database, encryption),
      testService: new WebhookTestEventService(testEvents, encryption),
      ingress: Object.freeze({
        database,
        testEvents,
        encryption,
        checkpointFactory: initialCheckpointFactory({ catalog }),
        logger: silentLogger,
      }),
      close: async () => {
        keys.close();
        await Promise.all([database.close(), testEvents.close()]);
      },
    }),
  );
}
