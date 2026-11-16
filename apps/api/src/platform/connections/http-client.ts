import {
  createNodeSecureHttpClient,
  SECURE_HTTP_PROVIDER_SECURITY,
  type SecureHttpClient,
} from '@pertexo/secrets/server';
import { createProviderHttpClient } from '@pertexo/integrations/server';

/** The provider client over the secure client, composed once per application. */
export function provideHttpClient(
  client: Pick<SecureHttpClient, 'execute' | 'executeStreaming'>,
) {
  return createProviderHttpClient(client, SECURE_HTTP_PROVIDER_SECURITY);
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
