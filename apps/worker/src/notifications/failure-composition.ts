import { createFailureNotificationStore } from '@pertexo/core/notifications';
import { createConnectionEnvelopeEncryption } from '@pertexo/secrets/server';

import { createNodeProviderHttpClient } from '../providers/http-client.js';
import {
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
  encryption: createConnectionEnvelopeEncryption,
  httpClient: createNodeProviderHttpClient,
  slack: createSlackClient,
  email: createResendClient,
  create: createProviderFailureNotificationDelivery,
});
