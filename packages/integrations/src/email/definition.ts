import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import {
  emailSendNotificationConfigSchema,
  emailSendNotificationInputSchema,
  emailSendNotificationOutputSchema,
} from './validation.js';

export const EMAIL_SEND_NOTIFICATION_DEFINITION = Object.freeze({
  key: 'email.send_notification',
  version: 1,
});
export const EMAIL_SEND_NOTIFICATION_EXECUTOR = Object.freeze({
  key: 'email.send_notification',
  version: 1,
});
export const RESEND_API_KEY_CONNECTION_SLOT = 'resend_api_key' as const;
export const EMAIL_SEND_NOTIFICATION_POLICY = Object.freeze({
  key: 'email.send_notification',
  version: 1,
});

export const EMAIL_SEND_NOTIFICATION_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: EMAIL_SEND_NOTIFICATION_DEFINITION,
  family: 'action',
  configVersion: 1,
  configSchema: generateSchemaDocument(emailSendNotificationConfigSchema),
  inputSchema: generateSchemaDocument(emailSendNotificationInputSchema),
  outputSchema: generateSchemaDocument(emailSendNotificationOutputSchema),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([RESEND_API_KEY_CONNECTION_SLOT]),
  connectionRequirements: Object.freeze([RESEND_API_KEY_CONNECTION_SLOT]),
  integration: Object.freeze({
    providerKey: 'email',
    operationKey: 'send_notification',
  }),
  retryClass: 'idempotent-with-key',
  resourceClass: 'io',
  capabilities: Object.freeze(['external_http', 'side_effect_disclosure']),
  lifecycle: 'active',
  executor: EMAIL_SEND_NOTIFICATION_EXECUTOR,
  executorAbi: 2,
  policyReferences: Object.freeze([EMAIL_SEND_NOTIFICATION_POLICY]),
});

export const EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION = Object.freeze({
  manifest: EMAIL_SEND_NOTIFICATION_MANIFEST,
  configSchema: emailSendNotificationConfigSchema,
  inputSchema: emailSendNotificationInputSchema,
  outputSchema: emailSendNotificationOutputSchema,
});
