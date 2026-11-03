import {
  createPlatformNodeRegistry as assemblePlatformNodeRegistry,
  type PlatformNodeRegistryDependencies,
} from '@pertexo/node-catalog/server';
import {
  createSlackClient,
  createResendClient,
} from '@pertexo/integrations/server';
import { createNodeProviderHttpClient } from './http-client.js';

/** Worker composition owns live provider clients and their safe network policy. */
export function createPlatformNodeRegistry(
  dependencies: Partial<PlatformNodeRegistryDependencies> = {},
) {
  return assemblePlatformNodeRegistry({
    ...dependencies,
    httpRequest: dependencies.httpRequest ?? {
      httpClient: createNodeProviderHttpClient(),
    },
    slackSendMessage: dependencies.slackSendMessage ?? {
      client: createSlackClient(createNodeProviderHttpClient()),
    },
    emailSendNotification: dependencies.emailSendNotification ?? {
      client: createResendClient(createNodeProviderHttpClient()),
    },
  });
}
