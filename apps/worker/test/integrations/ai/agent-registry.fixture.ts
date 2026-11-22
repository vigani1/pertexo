import {
  INTEGRATION_MODULES,
  type IntegrationModule,
} from '@pertexo/integrations/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createNodeCatalog, executorManifestFor } from '@pertexo/node-sdk';
import { createNodeRegistry } from '@pertexo/node-sdk/server';
import type { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import { isAgentDefinition } from '@pertexo/workflow-model';

import { createNodeProviderHttpClient } from '../../../src/providers/http-client.js';
import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';

const agentStep = INTEGRATION_MODULES.flatMap(
  (module: IntegrationModule) => module.steps,
).find(({ registration: { manifest } }) =>
  isAgentDefinition(manifest.definition),
);
if (agentStep === undefined)
  throw new Error('Agent integration step is missing');
const { registration, createExecutor } = agentStep;
export const catalog = createNodeCatalog({
  definitions: [...PLATFORM_NODE_CATALOG.definitions, registration.manifest],
  executors: [
    ...PLATFORM_NODE_CATALOG.executors,
    executorManifestFor(registration.manifest),
  ],
  policies: PLATFORM_NODE_CATALOG.policies,
});
export const executableCatalog = composeExecutableCatalog(catalog);
export function agentRegistry(
  allowedPrivateNetworks: ReturnType<typeof parseAllowedPrivateNetworks>,
) {
  const httpClient = createNodeProviderHttpClient({ allowedPrivateNetworks });
  const platform = createPlatformNodeRegistry({ httpClient });
  const agent = createNodeRegistry({
    catalog: createNodeCatalog({
      definitions: [registration.manifest],
      executors: [executorManifestFor(registration.manifest)],
      policies: [],
    }),
    definitions: [registration],
    executors: [
      createExecutor({
        httpClient,
        fixedEndpointHttpClient: httpClient,
      }),
    ],
  });
  return {
    dispatchMode: (request: Parameters<typeof platform.dispatchMode>[0]) =>
      (isAgentDefinition(request.definition) ? agent : platform).dispatchMode(
        request,
      ),
    execute: (request: Parameters<typeof platform.execute>[0]) =>
      (isAgentDefinition(request.definition) ? agent : platform).execute(
        request,
      ),
  };
}
