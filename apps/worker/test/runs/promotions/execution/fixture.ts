import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import { composeExecutableCatalog } from '@pertexo/workflow-engine';

export const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);

export const definitions = {
  definitions: PLATFORM_NODE_CATALOG.definitions.map((manifest) => ({
    ...manifest.definition,
    ...(manifest.integration === undefined
      ? {}
      : {
          integration: {
            ...manifest.integration,
            connectionSlots: manifest.connectionRequirements,
          },
        }),
  })),
};

export const policies = {
  definitions: PLATFORM_NODE_CATALOG.definitions.map((manifest) => ({
    definition: manifest.definition,
    policyReferences: manifest.policyReferences,
  })),
};
