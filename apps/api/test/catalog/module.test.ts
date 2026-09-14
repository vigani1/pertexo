import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { CatalogController } from '../../src/catalog/controllers.js';
import { CatalogModule } from '../../src/catalog/module.js';
import {
  ListIntegrationsUseCase,
  ListNodeDefinitionsUseCase,
} from '../../src/catalog/use-cases.js';
import { OpaqueSessionService } from '../../src/identity/index.js';
import { RequestContextStore } from '../../src/platform/http/index.js';

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}
Module({
  providers: [
    { provide: OpaqueSessionService, useValue: {} },
    RequestContextStore,
  ],
  exports: [OpaqueSessionService, RequestContextStore],
})(FakeIdentityModule);

describe('catalog Nest module', () => {
  it('registers static discovery use cases behind the identity module', () => {
    const dynamic = CatalogModule.register(
      { cohort: 'core' },
      { module: FakeIdentityModule },
    );
    expect(dynamic.controllers).toEqual([CatalogController]);
    expect(dynamic.imports).toEqual([{ module: FakeIdentityModule }]);
    expect(dynamic.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: ListNodeDefinitionsUseCase }),
        expect.objectContaining({ provide: ListIntegrationsUseCase }),
      ]),
    );
  });

  it('resolves the controller and both use cases through Nest injection', async () => {
    const dynamic = CatalogModule.register(
      { cohort: 'core' },
      { module: FakeIdentityModule },
    );
    const testing = await Test.createTestingModule({
      imports: [dynamic],
    }).compile();
    try {
      expect(testing.get(CatalogController)).toBeInstanceOf(CatalogController);
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
