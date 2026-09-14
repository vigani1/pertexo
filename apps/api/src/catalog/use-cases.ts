import {
  integrationListResponseSchema,
  nodeDefinitionListResponseSchema,
  type IntegrationListResponse,
  type NodeDefinitionListResponse,
} from '@pertexo/contracts/catalog';
import {
  platformBrowserNodeDefinitionCatalog,
  type PlatformNodeDefinitionBrowserCatalog,
  type PlatformNodeDefinitionBrowserProjection,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';

export type CatalogDependencies = Readonly<{
  cohort: PlatformReleaseCohort;
}>;

export class ListNodeDefinitionsUseCase {
  private readonly catalog: PlatformNodeDefinitionBrowserCatalog;

  public constructor(catalog: PlatformNodeDefinitionBrowserCatalog) {
    this.catalog = catalog;
  }

  public execute(): NodeDefinitionListResponse {
    return nodeDefinitionListResponseSchema.parse({
      schemaVersion: this.catalog.schemaVersion,
      release: this.catalog.release,
      items: this.catalog.definitions,
    });
  }
}

export class ListIntegrationsUseCase {
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
          .map(({ definition }) => definition),
        available: definitions.some(({ available }) => available),
        publishable: definitions.some(({ publishable }) => publishable),
      }));
    return integrationListResponseSchema.parse({
      schemaVersion: this.catalog.schemaVersion,
      release: this.catalog.release,
      items,
    });
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

function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Construct the immutable browser catalog once during module registration. */
export function createCatalogUseCases(
  dependencies: CatalogDependencies,
): Readonly<{
  readonly listNodeDefinitions: ListNodeDefinitionsUseCase;
  readonly listIntegrations: ListIntegrationsUseCase;
}> {
  const catalog = platformBrowserNodeDefinitionCatalog(dependencies.cohort);
  return Object.freeze({
    listNodeDefinitions: new ListNodeDefinitionsUseCase(catalog),
    listIntegrations: new ListIntegrationsUseCase(catalog),
  });
}
