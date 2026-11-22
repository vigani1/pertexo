import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import type { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';

import { createNodeProviderHttpClient } from '../../../src/providers/http-client.js';
import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';

export const catalog = PLATFORM_NODE_CATALOG;
export const executableCatalog = composeExecutableCatalog(catalog);

export function agentRegistry(
  allowedPrivateNetworks: ReturnType<typeof parseAllowedPrivateNetworks>,
) {
  return createPlatformNodeRegistry({
    httpClient: createNodeProviderHttpClient({ allowedPrivateNetworks }),
  });
}
