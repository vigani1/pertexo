import {
  WebhookTriggerEnvelopeEncryption,
  type WebhookTriggerSecretContext,
} from '@pertexo/integrations/server';
import type { ApiConfig } from '../../../src/platform/config/api.js';
import { createApiWebhookRuntime } from '../../../src/platform/webhooks/runtime.module.js';
import { createEditorBrowserEnvelopeKeys } from '../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { silentLogger } from '../../support/silent-logger.js';

/** Actual runtime, with test-owned authenticated wrapping instead of AWS KMS. */
export function createEditorWebhookRuntime(
  database: ApiConfig['database'],
  masterKey: Uint8Array,
) {
  return createApiWebhookRuntime(
    { kmsKeyReference: 'owned-editor-webhook', region: 'us-east-1' },
    database,
    {
      logger: silentLogger,
      databaseOverride: undefined,
      runtime: undefined,
      factories: {
        envelope: () => {
          const keys =
            createEditorBrowserEnvelopeKeys<WebhookTriggerSecretContext>(
              masterKey,
              'webhook',
            );
          return {
            encryption: new WebhookTriggerEnvelopeEncryption(keys),
            close: () => {
              keys.close();
            },
          };
        },
      },
    },
  );
}
