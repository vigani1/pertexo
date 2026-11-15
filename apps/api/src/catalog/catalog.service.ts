import { DEFAULT_CODE_SETTINGS, type CodeSettings } from '@pertexo/node-sdk';
import { compareOrdinal } from '@pertexo/workflow-model';
import type { IntegrationListResponse } from '@pertexo/contracts';
import {
  platformBrowserNodeDefinitionCatalog,
  type PlatformNodeDefinitionBrowserCatalog,
  type PlatformNodeDefinitionBrowserProjection,
} from '@pertexo/node-catalog';

export class ListNodeDefinitionsService {
  private readonly catalog: PlatformNodeDefinitionBrowserCatalog;

  public constructor(
    catalog: PlatformNodeDefinitionBrowserCatalog,
    private readonly codeSettings: CodeSettings = DEFAULT_CODE_SETTINGS,
  ) {
    this.catalog = catalog;
  }

  public execute() {
    return {
      items: this.catalog.definitions,
      codeSettings: this.codeSettings,
    };
  }
}

export class ListIntegrationsService {
  private readonly catalog: PlatformNodeDefinitionBrowserCatalog;

  public constructor(catalog: PlatformNodeDefinitionBrowserCatalog) {
    this.catalog = catalog;
  }

  public execute(): IntegrationListResponse {
    const byOperation = new Map<
      string,
      {
        readonly providerKey: string;
        readonly operationKey: string;
        readonly definitions: PlatformNodeDefinitionBrowserProjection[];
      }
    >();
    for (const definition of this.catalog.definitions) {
      const integration = definition.integration;
      if (integration === undefined) continue;
      const operation = `${integration.providerKey}\u0000${integration.operationKey}`;
      const existing = byOperation.get(operation);
      if (existing === undefined) {
        byOperation.set(operation, {
          providerKey: integration.providerKey,
          operationKey: integration.operationKey,
          definitions: [definition],
        });
      } else {
        existing.definitions.push(definition);
      }
    }
    const items = [...byOperation.values()]
      .sort(compareIntegration)
      .map(({ providerKey, operationKey, definitions }) => ({
        providerKey,
        operationKey,
        nodeDefinitions: definitions
          .sort(compareDefinition)
          // A copy, so no caller can change the catalog everyone reads.
          .map(({ definition }) => ({
            key: definition.key,
            version: definition.version,
          })),
      }));
    return {
      items,
    };
  }
}

function compareIntegration(
  left: Readonly<{ providerKey: string; operationKey: string }>,
  right: Readonly<{ providerKey: string; operationKey: string }>,
): number {
  const byProvider = compareOrdinal(left.providerKey, right.providerKey);
  return byProvider === 0
    ? compareOrdinal(left.operationKey, right.operationKey)
    : byProvider;
}

function compareDefinition(
  left: PlatformNodeDefinitionBrowserProjection,
  right: PlatformNodeDefinitionBrowserProjection,
): number {
  const byKey = compareOrdinal(left.definition.key, right.definition.key);
  return byKey === 0
    ? left.definition.version - right.definition.version
    : byKey;
}

/** Construct the immutable browser catalog once during module registration. */
export function createCatalogServices(
  codeSettings: CodeSettings = DEFAULT_CODE_SETTINGS,
): Readonly<{
  readonly listNodeDefinitions: ListNodeDefinitionsService;
  readonly listIntegrations: ListIntegrationsService;
}> {
  const catalog = platformBrowserNodeDefinitionCatalog();
  return Object.freeze({
    listNodeDefinitions: new ListNodeDefinitionsService(catalog, codeSettings),
    listIntegrations: new ListIntegrationsService(catalog),
  });
}
