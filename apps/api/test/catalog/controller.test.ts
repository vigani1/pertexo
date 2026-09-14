import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { CatalogController } from '../../src/catalog/controllers.js';
import { SessionAuthenticationGuard } from '../../src/identity-workspace/index.js';
import {
  platformBrowserNodeDefinitionCatalog,
  type PlatformNodeDefinitionBrowserCatalog,
  type PlatformNodeDefinitionBrowserProjection,
} from '@pertexo/node-catalog';
import {
  ListIntegrationsUseCase,
  createCatalogUseCases,
} from '../../src/catalog/use-cases.js';
import {
  integrationListResponseSchema,
  nodeDefinitionListResponseSchema,
} from '@pertexo/contracts/catalog';
import { RATE_LIMIT_METADATA } from '../../src/platform/rate-limit/metadata.js';

describe('catalog controller public seam', () => {
  it('returns the exact safe, release-pinned node projection', () => {
    const useCases = createCatalogUseCases({ cohort: 'core' });
    const controller = new CatalogController(
      useCases.listNodeDefinitions,
      useCases.listIntegrations,
    );
    const response = controller.listNodeDefinitions();
    expect(nodeDefinitionListResponseSchema.parse(response)).toEqual(response);
    expect(response.release.fingerprint).toMatch(/^node-compat:v1:sha256:/u);
    for (const item of response.items) {
      expect(item).not.toHaveProperty('executor');
      expect(item).not.toHaveProperty('executorAbi');
      expect(item).not.toHaveProperty('policyReferences');
    }
  });

  it('groups shuffled definitions with ordinal ties and numeric versions', () => {
    const catalog = customCatalog();
    const useCase = new ListIntegrationsUseCase(catalog);
    const response = useCase.execute();
    expect(integrationListResponseSchema.parse(response)).toEqual(response);
    expect(response.items).toEqual([
      {
        providerKey: 'email',
        operationKey: 'archive',
        nodeDefinitions: [{ key: 'archive.node', version: 1 }],
        available: false,
        publishable: true,
      },
      {
        providerKey: 'email',
        operationKey: 'notify',
        nodeDefinitions: [
          { key: 'alpha.node', version: 2 },
          { key: 'alpha.node', version: 10 },
          { key: 'zeta.node', version: 1 },
        ],
        available: true,
        publishable: true,
      },
      {
        providerKey: 'http',
        operationKey: 'request',
        nodeDefinitions: [{ key: 'http.node', version: 1 }],
        available: true,
        publishable: false,
      },
    ]);

    const firstOperation = response.items[0];
    const firstDefinition = response.items[1]?.nodeDefinitions[0];
    if (firstOperation === undefined || firstDefinition === undefined)
      throw new Error('Custom catalog projection is unexpectedly empty');
    Reflect.set(firstOperation, 'providerKey', 'zzz');
    Reflect.set(firstDefinition, 'version', 999);
    expect(useCase.execute().items).toEqual([
      expect.objectContaining({
        providerKey: 'email',
        operationKey: 'archive',
      }),
      expect.objectContaining({
        providerKey: 'email',
        operationKey: 'notify',
        nodeDefinitions: [
          { key: 'alpha.node', version: 2 },
          { key: 'alpha.node', version: 10 },
          { key: 'zeta.node', version: 1 },
        ],
      }),
      expect.objectContaining({ providerKey: 'http', operationKey: 'request' }),
    ]);
  });

  it('rejects unsupported query fields instead of accepting arbitrary filters', () => {
    const useCases = createCatalogUseCases({ cohort: 'core' });
    const controller = new CatalogController(
      useCases.listNodeDefinitions,
      useCases.listIntegrations,
    );
    expect(() => controller.listNodeDefinitions({ sort: 'key' })).toThrow();
    expect(() => controller.listIntegrations({ provider: 'http' })).toThrow();
  });

  it('keeps both routes authenticated and read-rate-limited', () => {
    const reflector = new Reflector();
    for (const method of ['listNodeDefinitions', 'listIntegrations']) {
      // TypeScript declares PropertyDescriptor.value as any; the runtime assertion
      // immediately below closes that reflection boundary.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const handler = Object.getOwnPropertyDescriptor(
        CatalogController.prototype,
        method,
      )?.value;
      expect(handler).toBeTypeOf('function');
      expect(
        // Nest's Reflector target type uses any internally.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        reflector.getAllAndOverride(RATE_LIMIT_METADATA, [
          handler,
          CatalogController,
        ]),
      ).toBe('authenticated_read');
      expect(
        // Nest's Reflector target type uses any internally.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        reflector.getAllAndMerge(GUARDS_METADATA, [handler, CatalogController]),
      ).toContain(SessionAuthenticationGuard);
    }
  });
});

function customCatalog(): PlatformNodeDefinitionBrowserCatalog {
  const source = platformBrowserNodeDefinitionCatalog('email_activation');
  const base = source.definitions[0];
  if (base === undefined)
    throw new Error('Platform browser catalog fixture is unexpectedly empty');
  const definition = (
    key: string,
    version: number,
    providerKey: string | undefined,
    operationKey: string | undefined,
    available: boolean,
    publishable: boolean,
  ): PlatformNodeDefinitionBrowserProjection => {
    const { integration, ...common } = base;
    void integration;
    return {
      ...common,
      definition: { key, version },
      ...(providerKey === undefined || operationKey === undefined
        ? {}
        : { integration: { providerKey, operationKey } }),
      available,
      publishable,
    };
  };
  return {
    schemaVersion: 1,
    release: source.release,
    definitions: [
      definition('zeta.node', 1, 'email', 'notify', false, false),
      definition('http.node', 1, 'http', 'request', true, false),
      definition('alpha.node', 10, 'email', 'notify', false, true),
      definition('local.node', 1, undefined, undefined, true, true),
      definition('archive.node', 1, 'email', 'archive', false, true),
      definition('alpha.node', 2, 'email', 'notify', true, false),
    ],
  };
}
