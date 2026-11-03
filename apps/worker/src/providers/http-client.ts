import {
  createNodeSecureHttpClient,
  SecureHttpError,
  inspectSecureHttpError,
  redactText,
  type SecureHttpClient,
} from '@pertexo/secrets/server';
import { createProviderHttpClient } from '@pertexo/integrations/server';

/** Adapts safe-network errors once at application composition. */
export function provideHttpClient(
  client: Pick<SecureHttpClient, 'execute' | 'executeStreaming'>,
) {
  return createProviderHttpClient(client, {
    inspectError: inspectSecureHttpError,
    createError: (failure) =>
      new SecureHttpError(failure.code, failure.classification, failure),
    redactText,
  });
}

export function createNodeProviderHttpClient(
  ...options: Parameters<typeof createNodeSecureHttpClient>
) {
  const client = createNodeSecureHttpClient(...options);
  return Object.freeze({
    ...provideHttpClient(client),
    isAddressBlocked: client.isAddressBlocked.bind(client),
  });
}
