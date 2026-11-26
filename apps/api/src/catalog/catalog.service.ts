import { DEFAULT_CODE_SETTINGS, type CodeSettings } from '@pertexo/node-sdk';
import type { AssistantDisclosure } from '@pertexo/node-sdk/server';
import { compareOrdinal, type WorkflowNode } from '@pertexo/workflow-model';
import type { IntegrationListResponse } from '@pertexo/contracts';
import {
  platformBrowserNodeDefinitionCatalog,
  connectionFormCatalog,
  resolvePlatformNodeDefinition,
  type PlatformNodeDefinitionBrowserCatalog,
  type PlatformNodeDefinitionBrowserProjection,
} from '@pertexo/node-catalog';

/** Each served definition's assistant disclosure, by `key@version`. */
export type AssistantDisclosures = ReadonlyMap<string, AssistantDisclosure>;

export class ListNodeDefinitionsService {
  private readonly catalog: PlatformNodeDefinitionBrowserCatalog;

  public constructor(
    catalog: PlatformNodeDefinitionBrowserCatalog,
    private readonly codeSettings: CodeSettings = DEFAULT_CODE_SETTINGS,
    private readonly disclosures: AssistantDisclosures = new Map(),
  ) {
    this.catalog = catalog;
  }

  public execute() {
    return {
      items: this.catalog.definitions,
      codeSettings: this.codeSettings,
      connections: connectionFormCatalog(),
    };
  }

  /**
   * What the assistant may see of a saved step. A step saved under another
   * config version keeps fields the declaration may not name, so it has none.
   */
  public readonly assistantDisclosure = (
    node: Pick<WorkflowNode, 'definition' | 'configVersion'>,
  ): AssistantDisclosure | undefined => {
    const { key, version } = node.definition;
    const definition = this.catalog.definitions.find(
      (item) =>
        item.definition.key === key && item.definition.version === version,
    );
    return definition?.configVersion === node.configVersion
      ? this.disclosures.get(disclosureKey(definition.definition))
      : undefined;
  };
}

function disclosureKey({
  key,
  version,
}: Readonly<{ key: string; version: number }>) {
  return `${key}@${String(version)}`;
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
  const disclosures = new Map(
    catalog.definitions.flatMap(({ definition }) => {
      const { assistantDisclosure } = resolvePlatformNodeDefinition(definition);
      return assistantDisclosure === undefined
        ? []
        : [[disclosureKey(definition), assistantDisclosure] as const];
    }),
  );
  return Object.freeze({
    listNodeDefinitions: new ListNodeDefinitionsService(
      catalog,
      codeSettings,
      disclosures,
    ),
    listIntegrations: new ListIntegrationsService(catalog),
  });
}
