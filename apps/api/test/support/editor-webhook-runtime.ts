import {
  WebhookTriggerEnvelopeEncryption,
  type WebhookTriggerSecretContext,
} from '@pertexo/integrations/server';
import type { PlatformReleaseCohort } from '@pertexo/node-catalog';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import { createApiWebhookRuntime } from '../../src/platform/webhooks/webhook-runtime.module.js';
import { createEditorBrowserEnvelopeKeys } from '../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';

/** Actual runtime, with test-owned authenticated wrapping instead of AWS KMS. */
export function createEditorWebhookRuntime(
  database: ApiConfig['database'],
  cohort: PlatformReleaseCohort,
  masterKey: Uint8Array,
) {
  return createApiWebhookRuntime(
    { kmsKeyReference: 'owned-editor-webhook', region: 'us-east-1' },
    database,
    cohort,
    undefined,
    undefined,
    {
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
  );
}
