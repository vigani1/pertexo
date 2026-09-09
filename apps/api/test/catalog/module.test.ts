import { describe, expect, it } from 'vitest';

import { CatalogController } from '../../src/catalog/controllers.js';
import { CatalogModule } from '../../src/catalog/module.js';
import {
  ListIntegrationsUseCase,
  ListNodeDefinitionsUseCase,
} from '../../src/catalog/use-cases.js';

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}

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
});
