import { createSmtpEmailClient } from './smtp-email.js';
import {
  createSecurePostgresClient,
  type createSmtpClient,
  type SecureHttpAddressPolicy,
} from '@pertexo/secrets/server';
import {
  createPlatformNodeRegistry as assemblePlatformNodeRegistry,
  type PlatformNodeRegistryDependencies,
} from '@pertexo/node-catalog/server';
import { createNodeProviderHttpClient } from './http-client.js';
import {
  createEmailProviderTelemetry,
  createHttpProviderTelemetry,
  createSlackProviderTelemetry,
} from './telemetry.js';

/** Worker composition owns live provider clients and their safe network policy. */
export function createPlatformNodeRegistry(
  dependencies: Partial<PlatformNodeRegistryDependencies> = {},
  smtpPolicy: NonNullable<Parameters<typeof createSmtpClient>[1]> = {
    allowedPrivateNetworks: [],
    allowPlaintext: false,
  },
) {
  return assemblePlatformNodeRegistry({
    ...dependencies,
    database:
      dependencies.database ??
      createSecurePostgresClient(smtpPolicy.allowedPrivateNetworks),
    httpClient: dependencies.httpClient ?? createNodeProviderHttpClient(),
    fixedEndpointHttpClient:
      dependencies.fixedEndpointHttpClient ?? createNodeProviderHttpClient(),
    smtp: dependencies.smtp ?? createSmtpEmailClient(smtpPolicy),
  });
}

export function createWorkerExecutionRegistry(
  httpRequest?: SecureHttpAddressPolicy,
  smtpPolicy?: NonNullable<Parameters<typeof createSmtpClient>[1]>,
) {
  return createPlatformNodeRegistry(
    {
      httpClient: createNodeProviderHttpClient(httpRequest),
      httpRequestTelemetry: createHttpProviderTelemetry(),
      slackSendMessageTelemetry: createSlackProviderTelemetry(),
      emailSendNotificationTelemetry: createEmailProviderTelemetry(),
    },
    smtpPolicy,
  );
}
