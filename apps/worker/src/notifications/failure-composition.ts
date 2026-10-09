import { createFailureNotificationStore } from '@pertexo/database/notifications';
import {
  createAwsConnectionEnvelopeEncryption,
  createNodeSecureHttpClient,
  createResendClient,
  createSlackClient,
} from '@pertexo/integrations/server';
import { createFailureNotificationHandler } from './failure-handler.js';
import { createProviderFailureNotificationDelivery } from './failure-delivery.js';

/** Feature-owned defaults for the maintenance consumer and provider delivery. */
export const failureNotificationFactories = Object.freeze({
  handler: createFailureNotificationHandler,
  store: createFailureNotificationStore,
});

export const failureNotificationDeliveryFactories = Object.freeze({
  store: createFailureNotificationStore,
  encryption: createAwsConnectionEnvelopeEncryption,
  httpClient: createNodeSecureHttpClient,
  slack: createSlackClient,
  email: createResendClient,
  create: createProviderFailureNotificationDelivery,
});
