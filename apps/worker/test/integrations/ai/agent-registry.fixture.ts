import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import type { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import { createSlackClient } from '@pertexo/integrations/server';

import { createNodeProviderHttpClient } from '../../../src/providers/http-client.js';
import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';

export const catalog = PLATFORM_NODE_CATALOG;
export const executableCatalog = composeExecutableCatalog(catalog);

export function agentRegistry(
  allowedPrivateNetworks: ReturnType<typeof parseAllowedPrivateNetworks>,
  slackUrl?: string,
) {
  const httpClient = createNodeProviderHttpClient({ allowedPrivateNetworks });
  return createPlatformNodeRegistry({
    httpClient,
    ...(slackUrl === undefined
      ? {}
      : {
          slackSendMessage: {
            client: createSlackClient({
              execute: (request) =>
                httpClient.execute({
                  ...request,
                  url: new URL(new URL(request.url).pathname, slackUrl).href,
                }),
            }),
          },
        }),
  });
}
