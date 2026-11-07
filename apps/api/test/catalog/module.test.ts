import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { CatalogController } from '../../src/catalog/catalog.controller.js';
import { CatalogModule } from '../../src/catalog/catalog.module.js';
import {
  ListIntegrationsUseCase,
  ListNodeDefinitionsUseCase,
} from '../../src/catalog/catalog.service.js';
import { SESSION_AUTHORITY } from '../../src/workspaces/index.js';
import { RequestContextStore } from '../../src/platform/http/index.js';

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}
Module({
  providers: [
    { provide: SESSION_AUTHORITY, useValue: {} },
    RequestContextStore,
  ],
  exports: [SESSION_AUTHORITY, RequestContextStore],
})(FakeIdentityModule);

describe('catalog Nest module', () => {
  it('resolves the controller and both use cases through Nest injection', async () => {
    const dynamic = CatalogModule.register({ module: FakeIdentityModule });
    const testing = await Test.createTestingModule({
      imports: [dynamic],
    }).compile();
    try {
      const controller = testing.get(CatalogController);
      expect(
        controller
          .listNodeDefinitions()
          .items.some((node) => node.definition.key === 'core.set'),
      ).toBe(true);
      expect(controller.listIntegrations().items.length).toBeGreaterThan(0);
      expect(testing.get(ListNodeDefinitionsUseCase)).toBeInstanceOf(
        ListNodeDefinitionsUseCase,
      );
      expect(testing.get(ListIntegrationsUseCase)).toBeInstanceOf(
        ListIntegrationsUseCase,
      );
    } finally {
      await testing.close();
    }
  });
});
