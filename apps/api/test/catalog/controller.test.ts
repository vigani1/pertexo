import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { CatalogController } from '../../src/catalog/controllers.js';
import { SessionAuthenticationGuard } from '../../src/identity-workspace/index.js';
import {
  ListIntegrationsUseCase,
  ListNodeDefinitionsUseCase,
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

  it('derives deterministic integration operations from definitions', () => {
    const useCases = createCatalogUseCases({ cohort: 'email_activation' });
    const controller = new CatalogController(
      useCases.listNodeDefinitions,
      useCases.listIntegrations,
    );
    const response = controller.listIntegrations();
    expect(integrationListResponseSchema.parse(response)).toEqual(response);
    expect(response.items).toEqual(
      [...response.items].sort((left, right) =>
        `${left.providerKey}\u0000${left.operationKey}`.localeCompare(
          `${right.providerKey}\u0000${right.operationKey}`,
        ),
      ),
    );
    expect(response.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerKey: 'http',
          operationKey: 'request',
          available: true,
          publishable: true,
        }),
        expect.objectContaining({
          providerKey: 'slack',
          operationKey: 'send_message',
        }),
        expect.objectContaining({
          providerKey: 'email',
          operationKey: 'send_notification',
        }),
      ]),
    );
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

  it('exposes explicit use-case providers for Nest resolution', () => {
    expect(ListNodeDefinitionsUseCase).toBeTypeOf('function');
    expect(ListIntegrationsUseCase).toBeTypeOf('function');
  });
});
